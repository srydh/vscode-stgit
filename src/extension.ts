// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, window, commands } from 'vscode';
import { registerDiffMode } from './diff-mode';
import {
    openAndShowDiffDocument, refreshDiff, registerDiffProvider
} from './diff-provider';
import { run, runCommand, withTempDir } from './util';

async function uncommitFiles(files?: string[]) {
    const index = await run('git', ['write-tree']);
    if (index === '')
        return;
    await run('git', ['reset', '--mixed', '-q', 'HEAD']);
    if (files)
        await run('git', ['reset', '-q', 'HEAD^', '--', ...files]);
    else
        await run('git', ['read-tree', 'HEAD^']);

    // Workaround a problem where stgit refuses to refresh from the index if
    // a file is deleted in the index but present in the work tree.
    const gitDir = await run('git', ['rev-parse', '--absolute-git-dir']);
    await withTempDir(async (tempDir) => {
        const env = {
            GIT_WORK_TREE: tempDir,
            GIT_DIR: gitDir,
        };
        await runCommand('stg', ['refresh', '-i'], {env});
    });
    await run('git', ['read-tree', index]);
}

class Delta {
    readonly path: string;
    readonly srcSha: string;
    readonly destSha: string;
    readonly deleted: boolean;
    readonly added: boolean;
    readonly conflict: boolean;
    readonly permissionDelta: string;

    constructor(s: string) {
        const [part1, name] = s.split("\t");
        const [srcMod, destMod, srcSha, destSha] = part1.slice(1).split(" ");
        let perm = "";
        if (!srcMod.includes("755") && destMod.includes("755"))
            perm = " +x";
        else if (srcMod.includes("755") && destMod.includes("644"))
            perm = " -x";
        this.srcSha = srcSha;
        this.destSha = destSha;
        this.conflict = part1.endsWith('U');
        this.deleted = part1.endsWith('D');
        this.added = part1.endsWith('A');
        this.path = name;
        this.permissionDelta = perm;
    }
    public get docLine() {
        let what = "Modified";
        if (this.conflict)
            what = "Unresolved";
        if (this.deleted)
            what = "Deleted";
        if (this.added)
            what = "Added";
        const s = `${what}${this.permissionDelta}`;
        return `    ${s.padEnd(16)} ${this.path}`;
    }
}

class Patch {
    protected expanded = false;
    marked = false;
    deltas: Delta[] = [];
    private hasDetails = false;
    protected sha: string | null = null;
    private detailsFetcher: Promise<void> | null = null;
    private commitMessage: string | null = null;

    lineNum = 0;
    lines: string[] = [];

    constructor(
        public readonly description: string,
        public readonly label: string,
        public readonly kind: '+' | '-' | 'H' | 'I' | 'W',
        public readonly empty: boolean,
        private readonly symbol: "+" | "-" | ">" | " " = " ",
    ) {}

    async updateFromOld(old: Patch) {
        this.marked = old.marked;
        if (this.expanded !== old.expanded)
            await this.toggleExpanded();
    }
    updateLines(lineNum: number) {
        this.lineNum = lineNum;
        const m = this.marked ? '*' : ' ';
        const empty = this.empty ? "(empty) " : "";
        this.lines = [`${this.symbol}${m}${empty}${this.description}`];
        if (this.expanded) {
            if (!this.hasDetails)
                this.fetchDetails();
            for (const d of this.deltas)
                this.lines.push(d.docLine);
            if (!this.deltas.length) {
                this.lines.push("    <no files>");
            }
        }
    }
    protected makeDeltas(diffOutput: string) {
        const entries = diffOutput.split("\n").filter(s => s.includes("\t"));
        this.deltas = entries.map(s => new Delta(s));
    }
    protected async doFetchDetails(): Promise<void> { /* virtual */ }
    setMarked(marked: boolean): boolean { return false; }

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
        const tree = await run('git', ["diff-tree", "-r", this.sha]);
        this.makeDeltas(tree);
    }
    setMarked(marked: boolean) {
        const changed = this.marked !== marked;
        this.marked = marked;
        return changed;
    }
}

class WorkTree extends Patch {
    constructor() {
        super("Work Tree", "", 'W', false);
        this.expanded = true;
    }
    protected async doFetchDetails(): Promise<void> {
        await run('git', ["update-index", "-q", "--refresh"]);
        const tree = await run('git', ["diff-files", "-0"], {trim: false});
        this.makeDeltas(tree);
    }
}

class Index extends Patch {
    constructor() {
        super("Index", "", 'I', false);
        this.expanded = true;
    }
    protected async doFetchDetails(): Promise<void> {
        const tree = await run('git', ["diff-index", "--cached", "HEAD"]);
        this.makeDeltas(tree);
    }
}

class History extends Patch {
    protected sha: string;
    constructor(sha: string, description: string) {
        super(description, "", 'H', false);
        this.sha = sha;
    }
    protected async doFetchDetails(): Promise<void> {
        const tree = await run('git', ['diff-tree', '-r', this.sha]);
        this.makeDeltas(tree);
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

function sleep(ms: number){
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Stgit {
    private history: Patch[] = [];
    private applied: Patch[] = [];
    private popped: Patch[] = [];
    private index: Patch = new Index();
    private workTree: Patch = new WorkTree();
    private needRepair = false;
    private stgMissing = false;
    private branchInitialized = true;
    private warnedAboutMissingStgBinary = false;
    private historySize = 5;
    private branchName: string | null = null;

    // start of history
    private baseSha: string | null = null;

    private commentThread: vscode.CommentThread | null = null;

    // Patch being edited in editor
    private editPatch: Patch | null = null;

    mainViewColumn = window.tabGroups.all.length;

    constructor(
        public doc: vscode.TextDocument,
        public notifyDirty: () => void,
        private commentController: vscode.CommentController,
    ) {
        this.reload();
    }
    dispose() {
        /* nothing */
    }
    private get patches() {
        return [...this.history, ...this.applied,
            this.index, this.workTree, ...this.popped];
    }

    async reloadIndex() {
        const index = new Index();
        await index.updateFromOld(this.index);
        await index.fetchDetails();
        this.index = index;
        this.notifyDirty();
    }
    async reloadWorkTree() {
        const workTree = new WorkTree();
        await workTree.updateFromOld(this.workTree);
        await workTree.fetchDetails();
        this.workTree = workTree;
        this.notifyDirty();
    }
    async reloadPatches() {
        const m = new Map(this.patches.map(p => [p.label, p]));
        const patches = [];
        const work = [];

        const result = await runCommand(
            'stg', ['series', '-ae', '--description']);

        this.branchInitialized = result.ecode === 0;
        this.stgMissing = result.ecode < 0;

        if (this.stgMissing) {
            this.warnAboutMissingStGit();
        } else if (this.branchInitialized) {
            for (const line of result.stdout.split("\n")) {
                if (line) {
                    const p = StGitPatch.fromSeries(line);
                    const old = m.get(p.label);
                    if (old)
                        work.push(p.updateFromOld(old));
                    patches.push(p);
                }
            }
            for (const w of work)
                await w;
        }
        this.popped = patches.filter(p => p.kind === '-');
        this.applied = patches.filter(p => p.kind !== '-');
        this.notifyDirty();
    }
    reload() {
        this.fetchBranchName();
        this.reloadPatches();
        this.fetchHistory(this.historySize);
        this.reloadIndexAndWorkTree();
        this.checkForRepair();
    }
    reloadIndexAndWorkTree() {
        this.reloadIndex();
        this.reloadWorkTree();
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
        const top = await run ('stg', ['top']);
        const topArgs = top.length ? [top] : [];
        const stgHeadPromise = run('stg', ['id', '--', ...topArgs]);
        const gitHeadPromise = run('git', ['rev-parse', 'HEAD']);
        const stgHead = await stgHeadPromise;
        const gitHead = await gitHeadPromise;
        const needRepair = (stgHead !== gitHead) && stgHead !== '';
        if (this.needRepair !== this.needRepair) {
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
            await run('stg', ['goto', '--', p.label]);
        else if (p?.kind === 'H')
            await run('stg', ['pop', '-a', ]);
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
            await run('stg', ['push', '--', ...patches]);
        } else if (applied.length) {
            const patches = applied.map(p => p.label);
            await run('stg', ['pop', '--', ...patches]);
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
            await run('stg', ['float', '--', ...patches]);
        } else if (this.applied.includes(p)) {
            await run('stg', ['sink', '-t', p.label, '--', ...patches]);
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
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.commentThread = thread;

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
        if (!p || [this.index, this.workTree].includes(p))
            return;
        this.editPatch = p;
        const template = await run(
            'stg', ['edit', '--save-template', '-', '--', p.label]);
        const simplified = template.split("\n").filter((s) => {
            for (const x of ['#', 'Patch:', 'Date:', 'From:']) {
                if (s.startsWith(x))
                    return false;
            }
            return true;
        }).join("\n").trim();
        this.openCommentEditor(p.lineNum, simplified, "stgit-edit");
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
                viewColumn: e.viewColumn, preview: true, preserveFocus: false};
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
                dstUri = vscode.Uri.joinPath(this.repoUri, delta.path);
            }
            vscode.commands.executeCommand("vscode.diff",
                srcUri, dstUri, `Diff ${delta.path}`, opts);
        }
    }
    async showDiffWithOpts(opts: {preserveFocus: boolean}) {
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
            if (delta)
                spec = `diff-index-${delta.path}#index,file=${delta.path}`;
            else
                spec = `diff-index#index`;
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
        this.showDiffWithOpts({preserveFocus: true});
    }
    openDiff() {
        this.showDiffWithOpts({preserveFocus: false});
    }
    async help() {
        vscode.commands.executeCommand(
            "workbench.action.quickOpen", ">StGit: ");
    }
    async newPatch() {
        await run('stg', ['new', '-m', 'internal']);
        this.reload();
    }
    async switchBranch() {
        if (this.index.deltas.length || this.workTree.deltas.length)
            return;
        const branches = run('git', ['branch']).then<string[]>((s) => {
            return s.replace("*", "").split("\n").map(s => s.trim());
        });
        const branch = await window.showQuickPick(branches, {
            placeHolder: "Select branch to checkout"
        });
        if (branch) {
            await run('git', ['switch', branch]);
            this.reload();
        }
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
            await run('stg', ['rebase', '--', base]);
            this.reload();
        }
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
            const uri = vscode.Uri.joinPath(this.repoUri, delta.path);
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
                await run('git', ['restore', '--', change.path]);
            } else {
                const files = patch.deltas.map(d => d.path);
                await run('git', ['restore', '--', ...files]);
            }
        }
        this.reloadIndexAndWorkTree();
    }
    async undo() {
        await run('stg', ['undo']);
        this.reload();
    }
    async hardUndo() {
        await run('stg', ['undo', '--hard']);
        this.reload();
    }
    async redo() {
        await run('stg', ['redo']);
        this.reload();
    }
    async popCurrentPatch() {
        await run('stg', ['pop']);
        this.reload();
    }
    async pushNextPatch() {
        await run('stg', ['push']);
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
    async moveCursorToIndexAtOpen() {
        const editor = this.editor;
        if (editor) {
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
            if (p.lineNum <= line && line < p.lineNum + p.lines.length)
                return p;
        }
        return null;
    }
    private get curChange(): Delta | null {
        const line = this.curLine;
        for (const p of this.patches) {
            if (p.lineNum < line && line < p.lineNum + p.lines.length)
                return p.deltas[line - p.lineNum - 1] ?? null;
        }
        return null;
    }
    get alternateViewColumn() {
        const col = this.mainViewColumn;
        return (col > 1) ? col - 1 : col + 1;
    }
    private get repoUri(): vscode.Uri {
        const d = workspace.workspaceFolders?.[0]?.uri;
        return d ? d : vscode.Uri.parse("unknown://repo/path");
    }

    get documentContents(): string {
        const b = this.branchName ?? this.baseSha?.slice(0, 16) ?? "<unknown>";
        const lines = [`Branch: ${b}`, ""];
        function pushVec(patches: Patch[]) {
            for (const p of patches) {
                p.updateLines(lines.length);
                lines.push(...p.lines);
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
        return lines.join("\n") + "\n--\n";
    }
}

class StgitExtension {
    static instance: StgitExtension | null;
    public stgit: Stgit | null = null;
    private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private channel = window.createOutputChannel('stgit');
    private commentController = vscode.comments.createCommentController(
        'stgit.comments', "StGit");

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
            cmd('reload', () => this.stgit?.reload()),
            cmd('resolveConflict', () => this.stgit?.resolveConflict()),
            cmd('gotoPatch', () => this.stgit?.gotoPatch()),
            cmd('markPatch', () => this.stgit?.markPatch()),
            cmd('unmarkPatch', () => this.stgit?.unmarkPatch()),
            cmd('toggleExpand', () => this.stgit?.toggleExpand()),
            cmd('toggleChanges', () => this.stgit?.toggleChanges()),
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

            window.onDidChangeVisibleTextEditors(editors => {
                if (this.stgit) {
                    for (const e of editors) {
                        if (e.document === this.stgit?.doc && e.viewColumn) {
                            this.stgit.mainViewColumn = e.viewColumn;
                            break;
                        }
                    }
                }
            }),
            // this event fires when an entire tab group is added or removed
            window.onDidChangeTextEditorViewColumn(ev => {
                if (ev.textEditor.document === this.stgit?.doc)
                    this.stgit.mainViewColumn = ev.viewColumn;
            }),
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
        this.channel.dispose();
        this.commentController.dispose();
        this.changeEmitter.dispose();
        StgitExtension.instance = null;
    }
    private async openStgit() {
        if (this.stgit) {
            this.stgit.focusWindow();
            this.stgit.reload();
        } else {
            const doc = await workspace.openTextDocument(this.uri);
            this.stgit = new Stgit(doc,
                () => this.changeEmitter.fire(doc.uri),
                this.commentController);
            const editor = await window.showTextDocument(doc, {
                viewColumn: this.stgit.mainViewColumn,
                preview: false,
            });
            const opts = editor.options;
            opts.lineNumbers = vscode.TextEditorLineNumbersStyle.Off;
            opts.cursorStyle = vscode.TextEditorCursorStyle.Block;
            this.stgit.moveCursorToIndexAtOpen();
        }
    }
    private get uri() {
        return vscode.Uri.from({scheme: "stgit", path: "/StGit"});
    }
    log(line: string): void {
        this.channel.appendLine(line);
    }
}

export function reloadIndexAndWorkTree() {
    StgitExtension.instance?.stgit?.reloadIndexAndWorkTree();
}

export function log(obj: string, ...args: {toString: () => string}[]) {
    const s = [obj, ...args.map(s => s.toString())].join(' ');
    StgitExtension.instance?.log(s);
}
export function info(msg: string) {
    window.showInformationMessage(msg);
}

export function activate(context: vscode.ExtensionContext) {
    StgitExtension.instance = new StgitExtension(context);
    registerDiffProvider(context);
    registerDiffMode(context);
}
export function deactivate() {
    // Nothing
}
