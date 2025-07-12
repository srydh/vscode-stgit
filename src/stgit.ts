// Copyright (C) 2022-2023, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, window, commands } from 'vscode';
import { openAndShowDiffDocument, refreshDiff } from './diff-provider';
import { run, runAndReportErrors, runCommand, sleep } from './util';
import { log, info, showStatusMessage, getUserConfirmation } from './extension';
import { uncommitFiles } from './git';
import { RepositoryInfo } from './repo';
import { getStGitConfig } from './config';

const RENAMEOPTS: readonly string[] = ['--no-renames'];

interface IndexStageInfo {
    perm: string;
    sha: string;
    stage: number
}
type DeltaKind = keyof (typeof Delta.STATUS_MESSAGE);

class Delta {
    private indexStageInfo: IndexStageInfo[] = [];

    static readonly STATUS_MESSAGE = {
        M: "Modified",
        D: "Deleted",
        A: "Added",
        O: "<unknown>",
        U: "Unresolved",
        R: "Rename",
        C: "Copy",
        T: "FileType",
        X: "X-Unknown",
    };

    constructor(
        private readonly srcMode: string,
        private readonly destMode: string,
        readonly srcSha: string,
        readonly destSha: string,
        private readonly status: DeltaKind,
        private readonly score: string,
        readonly path: string,
        readonly destPath: string | undefined,
    ) { }

    attachIndexStageInfo(stageInfo: IndexStageInfo[]) {
        this.indexStageInfo = stageInfo;
    }

    get deleted() {
        return this.status.startsWith('D');
    }
    get conflict() {
        return this.status.startsWith('U');
    }
    private get stageInfoString() {
        if (!this.indexStageInfo.length)
            return "";
        const m = this.indexStageInfo.reduce(
            (s, e) => s | (1 << (e.stage - 1)), 0);
        if (m === 3)
            return "(deleted by them)";
        if (m === 5)
            return "(deleted by us)";
        if (m === 6)
            return "(added by both)";
        if (m === 7)
            return "";
        return `(stage ${m})`;
    }
    private get permissionDelta(): string {
        const [sMode, dMode] = [this.srcMode, this.destMode];
        if (this.status !== 'U' && sMode !== '100755' && dMode === '100755')
            return " +x";
        else if (sMode === '100755' && dMode === '100644')
            return " -x";
        return "";
    }
    get docLine() {
        const what = Delta.STATUS_MESSAGE[this.status];
        const s = `${what}${this.permissionDelta}`;
        const dest = this.destPath ? ` -> ${this.destPath}` : '';
        const s2 = `    ${s.padEnd(16)} ${this.path}${dest}`;
        const sinfo = this.stageInfoString;
        if (!sinfo && !dest)
            return s2;
        return `${s2.padEnd(50)} ${sinfo}`;
    }
    static fromDiff(diffOutput: string): Delta[] {
        const entries: Delta[] = [];
        for (let s = diffOutput; ;) {
            const i0 = s.indexOf('\0');
            const spec = s.slice(1, i0);
            const [sMode, dMode, srcSha, destSha, status] = spec.split(" ");

            const i1 = s.indexOf('\0', i0 + 1);
            if (i1 < 0)
                break;
            const name = s.slice(i0 + 1, i1);

            let destName = undefined;
            if (status[0] === 'R' || status[0] === 'C') {
                const i2 = s.indexOf('\0', i1 + 1);
                destName = s.slice(i1 + 1, i2);
                s = s.slice(i2 + 1);
            } else {
                s = s.slice(i1 + 1);
            }
            const score = status.slice(1);
            const kind: DeltaKind = (status[0] in Delta.STATUS_MESSAGE) ?
                status[0] as DeltaKind : 'X';
            entries.push(new Delta(
                sMode, dMode, srcSha, destSha, kind, score, name, destName));
        }
        return entries;
    }
}

abstract class Patch {
    protected expanded = false;
    marked = false;
    deltas: Delta[] = [];
    protected sha: string | null = null;
    private detailsFetcher: Promise<void> | null = null;
    private commitMessage: string | null = null;

    // Line number for this patch in the StGit window
    lineNum = 0;
    // Number of lines displayed in the StGit window
    lineCount = 0;

    constructor(
        public readonly description: string,
        public readonly label: string,
        public readonly kind: '+' | '-' | 'H' | 'I' | 'W',
        public readonly empty: boolean,
        private readonly symbol: "+" | "-" | ">" | " " = " ",
    ) { }

    async updateFromOld(old: Patch) {
        this.marked = old.marked;
        if (this.expanded !== old.expanded)
            await this.toggleExpanded();
    }
    getLines(): string[] {
        const m = this.marked ? '*' : ' ';
        const empty = this.empty ? "(empty) " : "";
        const lines = [`${this.symbol}${m}${empty}${this.description}`];
        if (this.expanded) {
            for (const d of this.deltas)
                lines.push(d.docLine);
            if (!this.deltas.length) {
                lines.push("    <no files>");
            }
        }
        return lines;
    }
    updateLineSpan(lineNum: number, lineCount: number) {
        this.lineNum = lineNum;
        this.lineCount = lineCount;
    }

    protected abstract doFetchDetails(): Promise<void>;

    setMarked(marked: boolean): boolean {
        if (this.kind !== '+' && this.kind !== '-')
            return false;
        const changed = this.marked !== marked;
        this.marked = marked;
        return changed;
    }

    fetchDetails(): Promise<void> {
        if (!this.detailsFetcher)
            this.detailsFetcher = this.doFetchDetails();
        return this.detailsFetcher;
    }

    async getSha(): Promise<string | null> {
        await this.fetchDetails();
        return this.sha;
    }

    async getCommitMessage(): Promise<string | null> {
        if (!this.commitMessage) {
            const sha = await this.getSha();
            if (sha) {
                this.commitMessage = await run(
                    'git', ['show', '-s', '--format=%B', sha]);
            }
        }
        return this.commitMessage;
    }

    async toggleExpanded() {
        await this.fetchDetails();
        this.expanded = !this.expanded;
    }
}

class StGitPatch extends Patch {
    static fromSeries(line: string): Patch {
        const empty = line[0] === '0';
        const kind = line[1] === '-' ? '-' : '+';
        const symbol = line[1] as '+' | '-' | '>';
        const label = line.slice(2).split("#")[0].trim();
        const desc = (line.split("#")[1] ?? "").trim();
        return new this(desc, label, kind, empty, symbol);
    }
    protected async doFetchDetails(): Promise<void> {
        this.sha = await run('stg', ["id", "--", this.label]);
        const tree = await run('git', ['diff-tree',
            ...RENAMEOPTS, '-z', '--no-commit-id', '-r', this.sha]);
        this.deltas = Delta.fromDiff(tree);
    }
}

class WorkTree extends Patch {
    constructor(
        private readonly unknownFilesVisible: boolean,
    ) {
        super("Work Tree", "", 'W', false);
        this.expanded = true;
    }
    private async fetchUnknownFiles(): Promise<string> {
        if (!this.unknownFilesVisible)
            return "";
        const unknownFiles = await run(
            'git', ['ls-files', '--exclude-standard', '-o', '-z']);
        return unknownFiles.split("\0").filter(x => x).map(x => (
            ':000000 000000' +
            ' 0000000000000000000000000000000000000000' +
            ' 0000000000000000000000000000000000000000' +
            ` O\0${x}\0`)).join("");
    }

    protected async doFetchDetails(): Promise<void> {
        await run('git', ['update-index', '-q', '--refresh']);
        const result = await Promise.all([
            run('git', ['diff-files', ...RENAMEOPTS, '-z', '-0']),
            this.fetchUnknownFiles(),
        ]);
        this.deltas = Delta.fromDiff(result.join(""));
    }
}

class Index extends Patch {
    constructor() {
        super("Index", "", 'I', false);
        this.expanded = true;
    }
    protected async doFetchDetails(): Promise<void> {
        const tree = await run(
            'git', ['diff-index', ...RENAMEOPTS, '-z', '--cached', 'HEAD']);
        const deltas = Delta.fromDiff(tree);

        // Fetch information about index stages
        if (deltas.some(x => x.conflict)) {
            const s = await run('git', ['ls-files', '-u', '-z']);
            const entries = s.split("\0");
            const regexp = /([0-9]*) ([0-9a-f]*) ([1-3]*)\t(.*)/;
            for (const d of deltas.filter(d => d.conflict)) {
                const indexStageInfo: IndexStageInfo[] = [];
                for (const e of entries) {
                    const m = e.match(regexp);
                    if (m?.[4] === d.path) {
                        indexStageInfo.push({
                            perm: m[1],
                            sha: m[2],
                            stage: parseInt(m[3]),
                        });
                    }
                }
                d.attachIndexStageInfo(indexStageInfo);
            }
        }
        this.deltas = deltas;
    }
}

class History extends Patch {
    protected sha: string;
    constructor(sha: string, description: string) {
        super(description, "", 'H', false);
        this.sha = sha;
    }
    protected async doFetchDetails(): Promise<void> {
        const tree = await run('git', ['diff-tree',
            ...RENAMEOPTS, '-z', '--no-commit-id', '-r', this.sha]);
        this.deltas = Delta.fromDiff(tree);
    }
    static async fromRev(rev: string, limit: number) {
        if (limit === 0)
            return [];
        const log = await run('git', [
            'log', '--reverse', '--first-parent', `-n${limit}`,
            '--format=%H\t%s', rev]);
        if (log === "")
            return [];
        return log.split("\n").map(s => {
            const [sha, desc] = s.split("\t");
            return new History(sha, desc);
        });
    }
}

class StGitDoc {
    private unknownFilesVisible = false;

    private history: Patch[] = [];
    private applied: Patch[] = [];
    private popped: Patch[] = [];
    private index: Patch = new Index();
    private workTree: Patch = new WorkTree(this.unknownFilesVisible);
    private needRepair = false;
    private stgMissing = false;
    private branchInitialized = true;
    private warnedAboutMissingStgBinary = false;
    private historySize = 5;
    private branchName: string | null = null;
    private remoteName: string | null = null;
    private remoteBranch: string | null = null;
    private newUpstream = false;

    // start of history
    private baseSha: string | null = null;

    private commentThread: vscode.CommentThread | null = null;

    // Patch being edited in editor
    private editPatch: Patch | null = null;

    private mainViewColumn = window.tabGroups.all.length;

    private subscriptions: vscode.Disposable[] = [];

    private highlightRanges: vscode.Range[] = [];
    private historyRanges: vscode.Range[] = [];

    constructor(
        public doc: vscode.TextDocument,
        public repo: RepositoryInfo,
        public notifyDirty: () => void,
        private commentController: vscode.CommentController,
    ) {
        this.subscriptions.push(
            window.onDidChangeVisibleTextEditors(editors => {
                this.updateEditorDecorations();
                for (const e of editors) {
                    if (e.document === this.doc && e.viewColumn) {
                        this.mainViewColumn = e.viewColumn;
                        break;
                    }
                }
            }),
            workspace.onDidChangeTextDocument(ev => {
                if (ev.document === this.doc)
                    this.updateEditorDecorations();
            }),
            // this event fires when an entire tab group is added or removed
            window.onDidChangeTextEditorViewColumn(ev => {
                if (ev.textEditor.document === this.doc)
                    this.mainViewColumn = ev.viewColumn;
            }),
            getStGitConfig().onDidChangeConfiguration(() => {
                this.updateConfiguration({ reload: true });
            })
        );
        this.updateConfiguration({ reload: false });
        this.reload();
        this.openInitialEditor();
    }
    dispose() {
        this.subscriptions.forEach(s => s.dispose());
    }

    private get patches() {
        return [
            ...this.history,
            ...this.applied,
            this.index,
            this.workTree,
            ...this.popped,
        ];
    }
    private updateConfiguration(opt: { reload: boolean }) {
        const config = getStGitConfig();
        this.unknownFilesVisible = config.showUnknownFiles;
        if (opt.reload)
            this.reload();
    }

    async reloadIndex() {
        const index = new Index();
        await index.updateFromOld(this.index);
        await index.fetchDetails();
        this.index = index;
        this.notifyDirty();
    }
    async reloadWorkTree() {
        const workTree = new WorkTree(this.unknownFilesVisible);
        await workTree.updateFromOld(this.workTree);
        await workTree.fetchDetails();
        this.workTree = workTree;
        this.notifyDirty();
    }
    async reloadPatches() {
        const m = new Map(this.patches.map(p => [p.label, p]));
        const patches = [];

        const result = await runCommand(
            'stg', ['series', '-ae', '--description']);

        this.branchInitialized = result.ecode === 0;
        this.stgMissing = result.ecode < 0;

        if (this.stgMissing) {
            this.warnAboutMissingStGit();
        } else if (this.branchInitialized) {
            const work: Promise<void>[] = [];
            for (const line of result.stdout.split("\n")) {
                if (line) {
                    const p = StGitPatch.fromSeries(line);
                    const old = m.get(p.label);
                    if (old)
                        work.push(p.updateFromOld(old));
                    patches.push(p);
                    if (this.highlightPaths)
                        work.push(p.fetchDetails());
                }
            }
            await Promise.all(work);
        }
        this.popped = patches.filter(p => p.kind === '-');
        this.applied = patches.filter(p => p.kind !== '-');
        this.notifyDirty();
    }
    reload() {
        this.fetchBranchName();
        this.fetchUpstreamSpec();
        this.reloadPatches();
        this.fetchHistory(this.historySize);
        this.reloadIndexAndWorkTree();
        this.checkForRepair();
    }
    reloadIndexAndWorkTree() {
        this.reloadIndex();
        this.reloadWorkTree();
    }
    async fetchUpstreamSpec() {
        if (this.newUpstream)
            return;
        const upstream = await run('git', [
            'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
            { inhibitLogging: true });
        const n = upstream.search("/");
        const remote = upstream.slice(0, n) || this.remoteName;
        const remoteBranch = upstream.slice(n + 1) || null;
        if (this.remoteBranch !== remoteBranch || this.remoteName !== remote) {
            this.remoteBranch = remoteBranch;
            this.remoteName = remote;
            this.notifyDirty();
        }
    }
    async fetchBranchName() {
        const branch = await run('git', ['symbolic-ref', '--short', 'HEAD']);
        if (branch != this.branchName) {
            this.branchName = branch === "" ? null : branch;
            this.notifyDirty();
        }
    }
    async fetchHistory(historySize: number) {
        let sha = await run('stg', ['id', '--', '{base}']);
        if (sha === '')
            sha = await run('git', ['rev-parse', 'HEAD']);
        if (sha !== this.baseSha || this.historySize !== historySize) {
            this.baseSha = sha;
            this.historySize = historySize;
            this.history = await History.fromRev(
                this.baseSha, this.historySize);
            this.notifyDirty();
        }
    }
    async checkForRepair() {
        const top = await run('stg', ['top']);
        const topArgs = top.length ? [top] : [];
        const stgHeadPromise = run('stg', ['id', '--', ...topArgs]);
        const gitHeadPromise = run('git', ['rev-parse', 'HEAD']);
        const stgHead = await stgHeadPromise;
        const gitHead = await gitHeadPromise;
        const needRepair = (stgHead !== gitHead) && stgHead !== '';
        if (this.needRepair !== needRepair) {
            this.needRepair = needRepair;
            this.notifyDirty();
        }
    }
    warnAboutMissingStGit() {
        if (!this.warnedAboutMissingStgBinary) {
            this.warnedAboutMissingStgBinary = true;
            window.showErrorMessage('StGit binary (stg) not found');
        }
    }
    async refresh(extraArgs: string[] = []) {
        if (this.index.deltas.length) {
            this.index.deltas = [];
            this.notifyDirty();
            await run('stg', ['refresh', '--index', ...extraArgs]);
        } else {
            this.workTree.deltas = [];
            this.notifyDirty();
            await run('stg', ['refresh', ...extraArgs]);
        }
        this.reload();
    }
    async refreshSpecific() {
        const marked = this.applied.filter(x => x.marked);
        const popped = this.popped.filter(x => x.marked);
        if (popped.length) {
            info("Cannot refresh popped patches.");
            return;
        }
        const p = this.curPatch;
        if (!marked.length && p && this.applied.includes(p))
            marked.push(p);
        if (!marked)
            return;
        if (marked.length !== 1) {
            info("More than one patch is selected.");
            return;
        }
        this.refresh(['-p', marked[0].label]);
    }
    async repair() {
        await run('stg', ['repair']);
        this.reload();
    }
    async initializeBranch() {
        await run('stg', ['init']);
        this.reload();
    }
    async gotoPatch() {
        const p = this.curPatch;
        if (p?.label)
            await runAndReportErrors('stg', ['goto', '--', p.label]);
        else if (p?.kind === 'H')
            await runAndReportErrors('stg', ['pop', '-a',]);
        else
            return;
        this.reload();
    }
    async pushOrPopPatches() {
        const applied = this.applied.filter(p => p.marked);
        const popped = this.popped.filter(p => p.marked);
        const p = this.curPatch;
        if (!applied.length && !popped.length && p) {
            if (this.applied.includes(p))
                applied.push(p);
            else if (this.popped.includes(p))
                popped.push(p);
        }
        if (!applied.length && !popped.length)
            return;
        if (applied.length && popped.length) {
            info("Both pushed and popped patches selected.");
            return;
        }
        if (popped.length) {
            const patches = popped.map(p => p.label);
            await runAndReportErrors('stg', ['push', '--', ...patches]);
        } else if (applied.length) {
            const patches = applied.map(p => p.label);
            await runAndReportErrors('stg', ['pop', '--', ...patches]);
        }
        this.reload();
    }
    async movePatchesTo() {
        const p = this.curPatch;
        const patches = this.patches.filter(p => p.marked).map(p => p.label);
        if (!p || !patches.length)
            return;
        if (this.popped.includes(p)) {
            info("Cannot move patches below unapplied patches.");
            return;
        }
        if ([this.index, this.workTree].includes(p)) {
            await runAndReportErrors('stg', ['float', '--', ...patches]);
        } else if (this.applied.includes(p)) {
            await runAndReportErrors(
                'stg', ['sink', '-t', p.label, '--', ...patches]);
        }
        this.reload();
    }
    private async openCommentEditor(
        line: number, body: string, context: string) {
        const comment: vscode.Comment = {
            contextValue: context,
            body: body,
            mode: vscode.CommentMode.Editing,
            label: "(use 50/72 format)",
            author: {
                name: "Commit Message"
            }
        };
        this.commentThread?.dispose();
        const comments: vscode.Comment[] = [comment];
        const pos = new vscode.Position(line, 0);
        const range = new vscode.Range(pos, pos);
        const thread = this.commentController.createCommentThread(
            this.doc.uri, range, comments);
        thread.label = 'Enter commit message:';
        thread.contextValue = context;
        thread.canReply = false;
        thread.collapsibleState =
            vscode.CommentThreadCollapsibleState.Collapsed;
        thread.state = vscode.CommentThreadState.Unresolved;
        this.commentThread = thread;

        const delay = vscode.env.remoteName ? 400 : 200;
        await sleep(delay);
        await commands.executeCommand('workbench.action.expandAllComments');

        // It is difficult to determine when comment editor is really visible.
        // This is a workaround which works well in practice.
        const next = pos.translate(1);
        for (let i = 0; i < 8; i++) {
            await sleep(100);
            this.editor?.revealRange(new vscode.Range(pos, next));
        }
    }

    async createPatch() {
        const patch = this.index.deltas.length ? this.index : this.workTree;
        const line = patch.lineNum + patch.deltas.length;
        this.openCommentEditor(line, "", "stgit");
    }
    async editCommitMessage() {
        const p = this.curPatch;
        if (!p || !['+', '-'].includes(p.kind))
            return;
        this.editPatch = p;
        const sha = await p.getSha() ?? "error retrieving commit message>";
        const msg = await run('git', ['show', '-s', sha, '--format=%B']);
        this.openCommentEditor(p.lineNum, msg, "stgit-edit");
    }
    async commentCreatePatch() {
        if (this.commentThread) {
            const msg = this.commentThread.comments[0].body;
            this.cancel();
            if (msg) {
                await run('stg', ['new', '-m', msg as string]);
                this.refresh();
            }
        }
    }
    async completePatchEdit() {
        if (this.commentThread) {
            const msg = this.commentThread.comments[0].body;
            const editPatch = this.editPatch;
            this.cancel();
            if (msg && editPatch) {
                await run('stg', ['edit', '-m',
                    msg as string, '--', editPatch.label]);
                this.reload();
            }
        }
    }
    focusWindow() {
        window.showTextDocument(this.doc, {
            preview: false,
            viewColumn: this.mainViewColumn,
        });
    }
    async closeAllDiffEditors() {
        const editors = window.visibleTextEditors.filter(
            e => e.document.uri.scheme === 'stgit-diff');
        for (const e of editors) {
            // workaround for missing 'closeEditor' API:
            const opts: vscode.TextDocumentShowOptions = {
                viewColumn: e.viewColumn, preview: true, preserveFocus: false
            };
            await vscode.window.showTextDocument(e.document.uri, opts);
            commands.executeCommand('workbench.action.closeActiveEditor');
        }
    }
    async cancel() {
        this.commentThread?.dispose();
        this.commentThread = null;
        this.editPatch = null;
        await this.closeAllDiffEditors();
        this.focusWindow();
    }
    async squashPatches() {
        const patches = this.patches.filter(p => p.marked);
        if (patches.length <= 1)
            return;
        const labels = patches.map(p => p.label);
        const descriptions = patches.map(
            (p, i) => `${i + 1} - ${p.description}`);
        const desc = await window.showQuickPick(descriptions, {
            placeHolder: "Select commit comment:"
        });
        if (!desc)
            return;
        const patch = patches[descriptions.findIndex(x => x === desc)];
        const msg = await patch.getCommitMessage() ?? desc;

        const result = await runCommand(
            'stg', ['squash', '-m', msg, ...labels]);
        if (!result.ecode)
            patches.forEach(p => p.setMarked(false));
        this.reload();
    }
    async deletePatches() {
        const patch = this.curPatch;
        const patches = this.patches.filter(p => p.marked).map(p => p.label);
        if (patches.length) {
            await run('stg', ['delete', ...patches]);
            this.reload();
        } else if (patch?.kind === '-' || patch?.kind === '+') {
            await run('stg', ['delete', patch.label]);
            this.reload();
        }
    }
    private highlightPaths: Set<string> | null = null;
    async highlightFile() {
        const patch = this.curPatch;
        const delta = this.curChange;
        const work = this.applied.map(p => p.fetchDetails());
        await Promise.all(work);
        if (delta) {
            this.highlightPaths = new Set([delta.path]);
        } else if (patch) {
            this.highlightPaths = new Set(patch.deltas.map(x => x.path));
        } else {
            this.highlightPaths = null;
        }
        this.notifyDirty();
    }
    cancelHighlighting() {
        this.highlightPaths = null;
        this.notifyDirty();
    }
    async openDiffEditor() {
        const delta = this.curChange;
        if (delta) {
            const s = `stgit-blob:///${delta.path}`;
            const srcUri = vscode.Uri.parse(`${s}#${delta.srcSha}`);
            let dstUri = vscode.Uri.parse(`${s}#${delta.destSha}`);
            const opts: vscode.TextDocumentShowOptions = {
                viewColumn: this.alternateViewColumn,
                //preserveFocus: true,
                preview: true,
            };
            if (this.workTree.deltas.includes(delta)) {
                dstUri = this.repo.getPathUri(delta.path);
            }
            vscode.commands.executeCommand("vscode.diff",
                srcUri, dstUri, `Diff ${delta.path}`, opts);
        }
    }
    private async selectMergeDiffMode(delta: Delta): Promise<string | null> {
        if (!delta.conflict)
            return "";
        const modes = [
            { desc: '1 - Incoming Changes (base -> theirs)', mode: "13" },
            { desc: '2 - Local Changes (base -> ours)', mode: "12" },
            { desc: '3 - Our (ours -> work tree)', mode: "2" },
            { desc: '4 - Theirs (theirs -> work tree)', mode: "3" },
        ];
        const labels = modes.map(s => s.desc);
        const s = await window.showQuickPick(labels, {
            placeHolder: "Select diff type"
        });
        if (!s)
            return null;
        const mode = modes[labels.indexOf(s)].mode;
        return `,diffmode=${mode}`;
    }
    async showDiffWithOpts(opts: { preserveFocus: boolean }) {
        const delta = this.curChange;
        const patch = this.curPatch;
        const sha = await patch?.getSha();
        let spec: string | null = null;
        let invariant = false;
        if (patch && sha) {
            const s = `${sha.slice(0, 5)}`;
            if (delta)
                spec = `diff-${s}-${delta.path}#sha=${sha},file=${delta.path}`;
            else
                spec = `diff-${s}#sha=${sha}`;
            invariant = true;   // Diff contents never changes
        } else if (patch?.kind === 'I') {
            if (delta) {
                const m = await this.selectMergeDiffMode(delta);
                if (m === null)
                    return;
                spec = `diff-index-${delta.path}#index,file=${delta.path}${m}`;
            } else {
                spec = `diff-index#index`;
            }
        } else if (patch?.kind === 'W') {
            if (delta)
                spec = `diff-${delta.path}#file=${delta.path}`;
            else
                spec = `diff-work-tree`;
        }
        if (spec) {
            const uri = vscode.Uri.parse(`stgit-diff:///${spec}`);
            // If the uri is already open, we must force a refresh
            if (!invariant)
                refreshDiff(uri);
            openAndShowDiffDocument(uri, {
                viewColumn: this.alternateViewColumn,
                preserveFocus: opts.preserveFocus,
            });
        }
    }
    showDiff() {
        this.showDiffWithOpts({ preserveFocus: true });
    }
    openDiff() {
        this.showDiffWithOpts({ preserveFocus: false });
    }
    async help() {
        vscode.commands.executeCommand(
            "workbench.action.quickOpen", ">StGit: ");
    }
    async newPatch() {
        await run('stg', ['new', '-m', 'New patch']);
        this.reload();
    }
    async switchBranch() {
        if (this.index.deltas.length || this.workTree.deltas.length) {
            info("Work tree and index must be clean to switch branch");
            return;
        }
        const create = '$(plus) Create new branch';
        const branches = (await run('git', ['branch']).then<string[]>((s) => {
            return s.split("\n").map(s => s.replace(/^[*+]/, "").trim());
        }));
        const branch = await window.showQuickPick([create, ...branches], {
            placeHolder: "Select branch to checkout"
        });
        if (!branch) {
            return;
        } else if (branch.includes('Create new branch')) {
            const branch = await window.showInputBox({
                prompt: `Enter branch name`,
            });
            if (!branch)
                return;
            await runAndReportErrors('git', ['switch', '-c', branch]);
        } else if (branch) {
            await runAndReportErrors('git', ['switch', branch]);
        }
        this.newUpstream = false;
        this.reload();
    }
    private async allBranches() {
        const local = (await run('git', ['branch'])).split("\n");
        const remote = (await run('git', ['branch', '-r'])).split("\n");
        return [...local, ...remote].map(
            s => s.replace("*", "").trim()).filter(x => x);
    }
    async rebase() {
        const base = await window.showQuickPick(this.allBranches(), {
            placeHolder: "Select upstream branch for rebase"
        });
        if (base) {
            const result = await runAndReportErrors(
                'stg', ['rebase', '--', base]);
            this.reload();
            if (result.ecode === 0) {
                showStatusMessage(`Rebased series on top of '${base}'`);
            }
        }
    }

    async selectRemote() {
        const remotes = (await run('git', ['remote'])).split("\n");
        const remote = await window.showQuickPick(remotes, {
            placeHolder: "Select remote"
        });
        if (remote) {
            this.remoteName = remote.trim();
            this.remoteBranch = null;
            this.reload();
        }
    }

    async selectUpstreamBranch() {
        const clear = '$(close) Clear upstream setting';
        const remotes = (await run('git', ['remote']))
            .split("\n")
            .map(r => `$(plus) ${r.trim()}: New upstream branch`);
        const branches = (await run('git', ['branch', '-r']))
            .split("\n")
            .map(b => b.trim())
            .filter(b => !b.includes(" "));
        const upstream = await window.showQuickPick(
            [clear, ...remotes, ...branches],
            { placeHolder: "Select upstream branch" });
        if (!upstream) {
            return;
        } else if (upstream.includes("Clear upstream")) {
            this.remoteBranch = null;
            await run('git', ['branch', '--unset-upstream']);
        } else if (upstream.includes("$")) {
            const n = upstream.search(":");
            const s = upstream.search(" ");
            const remote = upstream.slice(s + 1, n);
            const branch = await window.showInputBox({
                prompt: `${remote} branch name`,
            });
            if (!branch)
                return;
            this.remoteName = remote;
            this.remoteBranch = branch;
            this.newUpstream = true;
        } else {
            const n = upstream.search("/");
            const remote = upstream.slice(0, n);
            const branch = upstream.slice(n + 1);
            if (!remote || !branch)
                return;
            this.remoteName = remote;
            this.remoteBranch = branch;
            this.newUpstream = false;
            await runAndReportErrors('git', [
                'branch', '--set-upstream-to',
                `${this.remoteName}/${this.remoteBranch}`]);
        }
        this.reload();
    }

    async gitFetch() {
        if (!this.remoteName)
            await this.selectRemote();
        if (this.remoteName) {
            const result = await runAndReportErrors(
                'git', ['fetch', this.remoteName]);
            if (result.ecode === 0) {
                log(`git fetch ${this.remoteName}: success`);
            }
        }
        showStatusMessage(`Fetched '${this.remoteName}'`);
    }

    async gitPush(kind: 'force' | 'fast-forward') {
        if (!this.remoteBranch)
            await this.selectUpstreamBranch();
        if (!this.remoteBranch || !this.remoteName)
            return;
        const forcePlus = kind === 'force' ? '+' : '';
        const spec = `${forcePlus}HEAD:${this.remoteBranch}`;

        const pushStr = kind == 'force' ? "Force-push" : "Push";
        const confirmationMsg = `${pushStr} ${spec} to ${this.remoteName}?`;
        if (!await getUserConfirmation(confirmationMsg))
            return;

        const result = await runAndReportErrors(
            'git', ['push', this.remoteName, spec],
            { errorMsg: 'push failed' });
        if (result.ecode !== 0)
            return;
        log(`git push ${this.remoteName} ${spec}: success`);
        if (result.stderr.includes("Create a pull request")) {
            const link = result.stderr.split("\n").filter(
                s => s.startsWith("remote:") && s.includes("https:"))[0];
            const s = `Create a GitHub pull request for ${this.remoteBranch}?`;
            if (await getUserConfirmation(s)) {
                const n = link.search("https://");
                const url = link.slice(n);
                vscode.env.openExternal(vscode.Uri.parse(url.trim()));
            }
        }
        showStatusMessage(`Pushed '${this.remoteName}/${this.remoteBranch}'`);
    }

    markPatch() {
        if (this.curPatch?.setMarked(true))
            this.notifyDirty();
        this.moveCursorToNextPatch();
    }
    unmarkPatch() {
        if (this.curPatch?.setMarked(false))
            this.notifyDirty();
        this.moveCursorToNextPatch();
    }
    async toggleExpand() {
        const patch = this.curPatch;
        const delta = this.curChange;
        if (delta) {
            const uri = this.repo.getPathUri(delta.path);
            if (!uri)
                return;
            const doc = await workspace.openTextDocument(uri);
            if (doc)
                window.showTextDocument(doc, {
                    viewColumn: this.alternateViewColumn,
                });
        } else if (patch && patch.lineNum === this.curLine) {
            await patch.toggleExpanded();
            this.notifyDirty();
        } else {
            const line = this.editor?.document.lineAt(this.curLine);
            if (line?.text.startsWith('!')) {
                if (this.needRepair)
                    this.repair();
                else if (!this.branchInitialized)
                    this.initializeBranch();
            }
        }
    }
    async resolveConflict() {
        const change = this.curChange;
        if (change) {
            if (change.conflict) {
                await run('git', ["add", change.path]);
                this.reload();
            } else {
                info("No conflict to resolve");
            }
        }
    }
    async toggleChanges() {
        // Move changes between index and work tree
        const patch = this.curPatch;
        const change = this.curChange;
        if (change?.conflict) {
            info("Conflicts must be marked as resolved (shift-R).");
            return;
        }
        if (patch?.kind === 'W') {
            if (change) {
                if (change.deleted)
                    await run('git', ['rm', '--', change.path]);
                else
                    await run('git', ['add', '--', change.path]);
            } else {
                await run('git', ['add', '-u']);
            }
            this.reloadIndexAndWorkTree();
        } else if (patch?.kind == 'I') {
            if (change)
                await run('git', ['restore', '-S', '--', change.path]);
            else
                await run('git', ["reset", "HEAD"]);
            this.reloadIndexAndWorkTree();
        } else if (patch && patch === this.applied.at(-1)) {
            if (change)
                await uncommitFiles([change.path]);
            else
                await uncommitFiles();
            this.reload();
        }
    }
    async revertChanges() {
        const patch = this.curPatch;
        const change = this.curChange;
        if (patch?.kind === 'I') {
            if (change) {
                log(['git', 'restore', '-WS', '--', change.path].join(" "));
                await run('git', ['restore', '-WS', '--', change.path]);
            } else {
                const files = patch.deltas.map(d => d.path);
                log(['git', 'restore', '-WS', '--', ...files].join(" '"));
                await run('git', ['restore', '-WS', '--', ...files]);
            }
        } else if (patch?.kind === 'W') {
            if (change) {
                if (change.conflict) {
                    // Redo index merge
                    await run('git', ['checkout', '-m', change.path]);
                } else {
                    await run('git', ['restore', '--', change.path]);
                }
            } else {
                const files = patch.deltas.map(d => d.path);
                await run('git', ['restore', '--', ...files]);
            }
        }
        this.reloadIndexAndWorkTree();
    }
    async undo() {
        await runAndReportErrors('stg', ['undo']);
        this.reload();
    }
    async hardUndo() {
        const msg = 'Perform a hard undo?' +
            ' Files not checked in could potentially be overwritten.';
        if (!await getUserConfirmation(msg))
            return;
        await runAndReportErrors('stg', ['undo', '--hard']);
        this.reload();
    }
    async redo() {
        await runAndReportErrors('stg', ['redo']);
        this.reload();
    }
    async popCurrentPatch() {
        await runAndReportErrors('stg', ['pop']);
        this.reload();
    }
    async pushNextPatch() {
        await runAndReportErrors('stg', ['push']);
        this.reload();
    }
    async setHistorySize() {
        const numStr = await window.showQuickPick([
            '0', '1', '5', '10', '15', '20', '25', '30', '35', '40'], {
            placeHolder: "Specify Git history size",
        });
        if (numStr) {
            const historySize = parseInt(numStr);
            this.fetchHistory(historySize);
        }
    }
    async commitOrUncommitPatches() {
        const curPatch = this.curPatch;
        if (curPatch?.kind === 'H') {
            const n = this.history.length - this.history.indexOf(curPatch);
            await run('stg', ['uncommit', `-n${n}`]);
        } else if (curPatch?.kind === '+') {
            const n = this.applied.indexOf(curPatch) + 1;
            await run('stg', ['commit', `-n${n}`]);
        } else {
            return;
        }
        this.reloadPatches();
        this.fetchHistory(this.historySize);
    }
    toggleShowingUnknownFiles() {
        this.unknownFilesVisible = !this.unknownFilesVisible;
        this.reloadWorkTree();
    }

    private moveCursorToNextPatch() {
        const list = this.patches;
        const curPatch = this.curPatch;
        const ind = list.findIndex(p => p === curPatch);
        const nextPatch = list[ind + 1];
        if (this.editor) {
            const line = nextPatch ? nextPatch.lineNum : this.curLine + 1;
            const pos = new vscode.Position(line, 2);
            this.editor.selection = new vscode.Selection(pos, pos);
        }
    }

    private async openInitialEditor() {
        const editor = await window.showTextDocument(this.doc, {
            viewColumn: this.mainViewColumn,
            preview: false,
        });
        const opts = editor.options;
        opts.lineNumbers = vscode.TextEditorLineNumbersStyle.Off;
        opts.cursorStyle = vscode.TextEditorCursorStyle.Block;

        // move cursor to Index
        this.moveCursorToIndexAtOpen(editor);
    }

    private async moveCursorToIndexAtOpen(editor: vscode.TextEditor) {
        let done = false;
        const watcher = workspace.onDidChangeTextDocument((e) => {
            if (e.document !== this.doc || done)
                return;
            const line = this.index.lineNum;
            if (line !== 0) {
                const p = new vscode.Position(line, 0);
                editor.selection = new vscode.Selection(p, p);
                editor.revealRange(new vscode.Range(p, p));
                done = true;
                return;
            }
        });
        await sleep(4000);
        watcher.dispose();
    }

    private updateDecorations() {
        this.highlightRanges = this.applied.filter(p =>
            p.deltas.some(d => this.highlightPaths?.has(d.path))).map(
                p => new vscode.Range(p.lineNum, 2, p.lineNum, 2));
        this.historyRanges = this.history.map(
            p => new vscode.Range(p.lineNum, 0, p.lineNum, 999));
        this.updateEditorDecorations();
    }

    private updateEditorDecorations() {
        for (const editor of window.visibleTextEditors) {
            if (editor.document !== this.doc)
                continue;

            const cls = StGitMode.instance!;
            editor.setDecorations(
                cls.fileHighlightDecoration, this.highlightRanges);
            editor.setDecorations(
                cls.historyDecoration, this.historyRanges);
        }
    }

    get editor(): vscode.TextEditor | null {
        const active = window.activeTextEditor;
        if (active?.document === this.doc) {
            return active;
        } else {
            return window.visibleTextEditors.find(
                e => (e.document === this.doc)) ?? null;
        }
    }
    private get curLine(): number {
        return this.editor?.selection.active.line ?? -1;
    }
    private get curPatch(): Patch | null {
        const line = this.curLine;
        for (const p of this.patches) {
            if (p.lineNum <= line && line < p.lineNum + p.lineCount)
                return p;
        }
        return null;
    }
    private get curChange(): Delta | null {
        const line = this.curLine;
        for (const p of this.patches) {
            if (p.lineNum < line && line < p.lineNum + p.lineCount)
                return p.deltas[line - p.lineNum - 1] ?? null;
        }
        return null;
    }
    get alternateViewColumn() {
        const col = this.mainViewColumn;
        return (col > 1) ? col - 1 : col + 1;
    }

    private get upstreamString(): string {
        if (this.remoteBranch && this.remoteName)
            return ` <-> ${this.remoteName}/${this.remoteBranch}`;
        if (this.remoteName)
            return ` (${this.remoteName})`;
        return '';
    }

    get documentContents(): string {
        const b = this.branchName ?? this.baseSha?.slice(0, 16) ?? "<unknown>";
        const lines = [`Branch: ${b}${this.upstreamString}`, ""];
        function pushVec(patches: Patch[]) {
            for (const p of patches) {
                const patchLines = p.getLines();
                p.updateLineSpan(lines.length, patchLines.length);
                lines.push(...patchLines);
            }
        }
        pushVec(this.history);
        pushVec(this.applied);
        if (!this.applied.length)
            lines.push("> <no patch applied>");
        if (this.stgMissing)
            lines.push("! *** StGit not installed ('stg' binary missing) ***");
        else if (!this.branchInitialized)
            lines.push("! *** Setup branch for StGit ('stg init') ***");
        else if (this.needRepair)
            lines.push("! *** Repair needed [C-u g] ***");
        pushVec([this.index]);
        pushVec([this.workTree]);
        pushVec(this.popped);

        this.updateDecorations();
        return lines.join("\n") + "\n--\n";
    }
}

class StGitMode {
    static instance: StGitMode | null;

    private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private commentController = vscode.comments.createCommentController(
        'stgit.comments', "StGit");

    stgit: StGitDoc | null = null;

    readonly fileHighlightDecoration = window.createTextEditorDecorationType({
        before: { contentText: "⏹ ", },
    });
    readonly historyDecoration = window.createTextEditorDecorationType({
        dark: { color: "#777", },
        light: { color: "#999", },
    });
    constructor(context: vscode.ExtensionContext) {
        const provider: vscode.TextDocumentContentProvider = {
            onDidChange: this.changeEmitter.event,
            provideTextDocumentContent: (uri: vscode.Uri, token) => {
                return this.stgit?.documentContents ?? "\nIndex\n";
            }
        };
        function cmd(cmd: string, func: () => void) {
            return commands.registerTextEditorCommand(`stgit.${cmd}`, func);
        }
        function globalCmd(cmd: string, func: () => void) {
            return commands.registerCommand(`stgit.${cmd}`, func);
        }
        context.subscriptions.push(
            this,       /* self dispose */

            globalCmd('open', () => this.openStgit()),
            cmd('refresh', () => this.stgit?.refresh()),
            cmd('repair', () => this.stgit?.repair()),
            cmd('refreshSpecific', () => this.stgit?.refreshSpecific()),
            cmd('switchBranch', () => this.stgit?.switchBranch()),
            cmd('rebase', () => this.stgit?.rebase()),
            cmd('gitFetch', () => this.stgit?.gitFetch()),
            cmd('gitPush', () => this.stgit?.gitPush('fast-forward')),
            cmd('gitForcePush', () => this.stgit?.gitPush('force')),
            cmd('selectRemote', () => this.stgit?.selectRemote()),
            cmd('selectUpstreamBranch',
                () => this.stgit?.selectUpstreamBranch()),
            cmd('reload', () => this.stgit?.reload()),
            cmd('resolveConflict', () => this.stgit?.resolveConflict()),
            cmd('gotoPatch', () => this.stgit?.gotoPatch()),
            cmd('markPatch', () => this.stgit?.markPatch()),
            cmd('unmarkPatch', () => this.stgit?.unmarkPatch()),
            cmd('toggleExpand', () => this.stgit?.toggleExpand()),
            cmd('toggleChanges', () => this.stgit?.toggleChanges()),
            cmd('toggleShowingUnknown',
                () => this.stgit?.toggleShowingUnknownFiles()),
            cmd('createPatch', () => this.stgit?.createPatch()),
            cmd('newPatch', () => this.stgit?.newPatch()),
            cmd('pushOrPopPatches', () => this.stgit?.pushOrPopPatches()),
            cmd('pushNextPatch', () => this.stgit?.pushNextPatch()),
            cmd('popCurrentPatch', () => this.stgit?.popCurrentPatch()),
            cmd('movePatchesTo', () => this.stgit?.movePatchesTo()),
            cmd('commentCreatePatch', () => this.stgit?.commentCreatePatch()),
            cmd('completePatchEdit', () => this.stgit?.completePatchEdit()),
            cmd('cancel', () => this.stgit?.cancel()),
            cmd('editCommitMessage', () => this.stgit?.editCommitMessage()),
            cmd('squashPatches', () => this.stgit?.squashPatches()),
            cmd('deletePatches', () => this.stgit?.deletePatches()),
            cmd('highlightFile', () => this.stgit?.highlightFile()),
            cmd('cancelHighlighting', () => this.stgit?.cancelHighlighting()),
            cmd('openDiffEditor', () => this.stgit?.openDiffEditor()),
            cmd('showDiff', () => this.stgit?.showDiff()),
            cmd('openDiff', () => this.stgit?.openDiff()),
            cmd('setHistorySize', () => this.stgit?.setHistorySize()),
            cmd('commitOrUncommitPatches',
                () => this.stgit?.commitOrUncommitPatches()),
            cmd('revertChanges', () => this.stgit?.revertChanges()),
            cmd('undo', () => this.stgit?.undo()),
            cmd('hardUndo', () => this.stgit?.hardUndo()),
            cmd('redo', () => this.stgit?.redo()),
            cmd('help', () => this.stgit?.help()),

            workspace.registerTextDocumentContentProvider('stgit', provider),

            workspace.onDidCloseTextDocument((doc) => {
                if (doc === this.stgit?.doc) {
                    this.stgit.dispose();
                    this.stgit = null;
                }
            }),
            workspace.onDidSaveTextDocument((doc) => {
                this.stgit?.reloadWorkTree();
            }),
        );
    }
    dispose() {
        this.stgit?.dispose();
        this.stgit = null;
        this.commentController.dispose();
        this.changeEmitter.dispose();
        StGitMode.instance = null;

        this.fileHighlightDecoration.dispose();
        this.historyDecoration.dispose();
    }
    private async openStgit() {
        if (this.stgit) {
            const scheme = window.activeTextEditor?.document.uri.scheme || "";
            const isInStgitBuffer = ['stgit', 'stgit-diff'].includes(scheme);
            if (!isInStgitBuffer) {
                const repo = await RepositoryInfo.lookup();
                if (!repo) {
                    info("Failed to find a GIT repository");
                    return;
                }
                this.stgit.repo = repo;
            }
            this.stgit.focusWindow();
            this.stgit.reload();
        } else {
            const repo = await RepositoryInfo.lookup();
            if (!repo) {
                info("Failed to find a GIT repository");
                return;
            }
            const doc = await workspace.openTextDocument(this.uri);
            this.stgit = new StGitDoc(doc, repo,
                () => this.changeEmitter.fire(doc.uri),
                this.commentController);
        }
    }
    private get uri() {
        return vscode.Uri.from({ scheme: "stgit", path: "/StGit" });
    }
}

export function registerStGitMode(context: vscode.ExtensionContext) {
    StGitMode.instance = new StGitMode(context);
}

export function reloadIndexAndWorkTree() {
    StGitMode.instance?.stgit?.reloadIndexAndWorkTree();
}
