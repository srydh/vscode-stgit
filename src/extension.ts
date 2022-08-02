// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, window, Uri, commands } from 'vscode';
import { spawn } from 'child_process';

function run(command: string, args: string[],
        opts = {trim: true}): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0].uri.path ?? "/tmp/";
    const proc = spawn(command, args, {cwd: cwd});
    const data: string[] = [];
    proc.stdout!.on('data', (s) => { data.push(s); });
    proc.stderr!.on('data', () => { /* nothing */ });
    return new Promise<string>((resolve, _) => {
        proc.on('close', (code) => {
            if (code === 0) {
                const s = data.join('');
                resolve(opts.trim ? s.trimEnd() : s);
            } else {
                resolve('');
            }
        });
    });
}

type PatchKind = '+' | '-' | '>' | 'H' | 'I' | 'W';

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
    expanded = false;
    marked = false;
    deltas: Delta[] = [];
    private hasDetails = false;
    protected sha = "0000";
    private detailsFetcher: Promise<void> | null = null;

    lineNum = 0;
    lines: string[] = [];

    constructor(
        private description: string,
        public label: string,
        public kind: PatchKind,
        public empty: boolean,
    ) {}

    updateFromOld(old: Patch) {
        this.expanded = old.expanded;
        this.marked = old.marked;
    }
    updateLines(lineNum: number) {
        this.lineNum = lineNum;
        const m = this.marked ? '*' : ' ';
        const k = "+->".includes(this.kind) ? this.kind : ' ';
        const empty = this.empty ? "(empty) " : "";
        this.lines = [`${k}${m}${empty}${this.description}`];
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
    setMarked(marked: boolean): void { /* ignore */ }

    fetchDetails(): Promise<void> {
        if (!this.detailsFetcher)
            this.detailsFetcher = this.doFetchDetails();
        return this.detailsFetcher;
    }

    async toggleExpanded() {
        if (!this.hasDetails)
            await this.fetchDetails();
        this.expanded = !this.expanded;
        notifyDirty();
    }
}

class StGitPatch extends Patch {
    static fromSeries(line: string): Patch {
        const empty = line[0] === '0';
        const kind = line[1] as PatchKind;
        const label = line.slice(2).split("#")[0].trim();
        const desc = (line.split("#")[1] ?? "").trim();
        return new this(desc, label, kind, empty);
    }
    protected async doFetchDetails(): Promise<void> {
        this.sha = await run('stg', ["id", "--", this.label]);
        const tree = await run('git', ["diff-tree", "-r", this.sha]);
        this.makeDeltas(tree);
    }
    setMarked(marked: boolean) {
        this.marked = marked;
        notifyDirty();
    }
}

class WorkTree extends Patch {
    constructor() {
        super("Work Tree", "", 'W', false);
        this.expanded = true;
    }
    protected async doFetchDetails(): Promise<void> {
        await run('git', ["update-index", "--refresh"]);
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
    constructor(sha: string, description: string) {
        super(description, "", 'H', false);
        this.sha = sha;
    }
    protected async doFetchDetails(): Promise<void> {
        const tree = await run('git', ['diff-tree', this.sha]);
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
    private header: string[] = ["StGit", ""];
    private needRepair = false;
    private historySize = 5;

    // start of history
    private baseSha: string | null = null;

    private commentThread: vscode.CommentThread | null = null;

    // Patch being edited in editor
    private editPatch: Patch | null = null;

    constructor(
        public doc: vscode.TextDocument,
        private notifyDirty: () => void,
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

    async reload() {
        const args = ['series', '-ae', '--description'];
        const s = await run('stg', args);

        this.fetchHistory(this.historySize);

        const m = new Map(this.patches.map(p => [p.label, p]));
        const patches = [];
        const work: Promise<void>[] = [];
        for (const line of s.split("\n")) {
            if (line) {
                const p = StGitPatch.fromSeries(line);
                const old = m.get(p.label);
                if (old)
                    p.updateFromOld(old);
                if (p.expanded)
                    work.push(p.fetchDetails());
                patches.push(p);
            }
        }
        // Reload index and workTree
        const index = new Index();
        const workTree = new WorkTree();
        index.updateFromOld(index);
        workTree.updateFromOld(workTree);
        work.push(
            index.fetchDetails(),
            workTree.fetchDetails(),
        );
        for (const w of work)
            await w;

        this.index = index;
        this.workTree = workTree;
        this.popped = patches.filter(p => p.kind === '-');
        this.applied = patches.filter(p => p.kind !== '-');
        this.notifyDirty();

        this.checkForRepair();
    }
    async fetchHistory(historySize: number) {
        const sha = await run('stg', ['id', '--', '{base}']);
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
        const needRepair = stgHead !== gitHead;
        if (needRepair !== this.needRepair) {
            this.needRepair = needRepair;
            this.notifyDirty();
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
        vscode.window.showTextDocument(this.doc, {
            preview: false,
            viewColumn: this.editor?.viewColumn,
        });
    }
    cancel() {
        this.commentThread?.dispose();
        this.commentThread = null;
        this.editPatch = null;
        this.focusWindow();
    }
    async squashPatches() {
        const patches = this.patches.filter(p => p.marked).map(p => p.label);
        if (patches.length) {
            await run('stg', ['squash', '-m', '[SQUASHED] patch', ...patches]);
            this.reload();
        }
    }
    async deletePatches() {
        const patches = this.patches.filter(p => p.marked).map(p => p.label);
        if (patches.length) {
            await run('stg', ['delete', ...patches]);
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
    async showDiff() {
        const delta = this.curChange;
        if (delta) {
            const s = `stgit-diff:///${delta.path}#${delta.srcSha}`;
            const uri = vscode.Uri.parse(s);
            const doc = await vscode.workspace.openTextDocument(uri);
            if (doc) {
                vscode.languages.setTextDocumentLanguage(doc, 'diff');
                const opts: vscode.TextDocumentShowOptions = {
                    viewColumn: this.alternateViewColumn,
                    preview: true,
                    preserveFocus: true,
                };
                vscode.window.showTextDocument(doc, opts);
                vscode.commands.executeCommand('stgit.open');
            }
        }
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
        const branch = await vscode.window.showQuickPick(branches, {
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
        const base = await vscode.window.showQuickPick(this.allBranches(), {
            placeHolder: "Select upstream branch for rebase"
        });
        if (base) {
            await run('stg', ['rebase', '--', base]);
            this.reload();
        }
    }
    markPatch() {
        this.curPatch?.setMarked(true);
        this.moveCursorToNextPatch();
    }
    unmarkPatch() {
        this.curPatch?.setMarked(false);
        this.moveCursorToNextPatch();
    }
    async toggleExpand() {
        const patch = this.curPatch;
        const delta = this.curChange;
        if (delta) {
            const uri = vscode.Uri.joinPath(this.repoUri, delta.path);
            const doc = await vscode.workspace.openTextDocument(uri);
            if (doc)
                vscode.window.showTextDocument(doc, {
                    viewColumn: this.alternateViewColumn,
                });
        } else if (patch && patch.lineNum === this.curLine) {
            patch?.toggleExpanded();
        } else {
            const line = this.editor?.document.lineAt(this.curLine);
            if (line?.text.startsWith('!'))
                this.repair();
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
        } else if (patch?.kind == 'I') {
            if (change)
                await run('git', ['restore', '-S', '--', change.path]);
            else
                await run('git', ["reset", "HEAD"]);
        }
        // FIXME: use faster reload primitive
        this.reload();
    }
    async revertChanges() {
        // TODO
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
        this.reload();
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
        const numStr = await vscode.window.showQuickPick([
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
        } else if (curPatch?.kind === '+' || curPatch?.kind === '>') {
            const n = this.applied.indexOf(curPatch) + 1;
            await run('stg', ['commit', `-n${n}`]);
        } else {
            return;
        }
        this.reload();
    }
    provideTextBlob(uri: vscode.Uri): Promise<string> {
        const sha = uri.fragment;
        return run('git', ['show', sha], {trim: false});
    }
    provideDiff(uri: vscode.Uri): Promise<string> {
        const sha = uri.fragment;
        const path = uri.path.slice(1);
        return run('git', ['diff', sha, '--', path], {trim: false});
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
    get editor(): vscode.TextEditor | null {
        const active = vscode.window.activeTextEditor;
        if (active?.document === this.doc) {
            return active;
        } else {
            return vscode.window.visibleTextEditors.find(
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
    get mainViewColumn() {
        return this.editor?.viewColumn ?? 3;
    }
    private get repoUri(): vscode.Uri {
        const d = vscode.workspace.workspaceFolders?.[0]?.uri;
        return d ? d : vscode.Uri.parse("unknown://repo/path");
    }

    get documentContents(): string {
        const lines = [...this.header];
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
        if (this.needRepair)
            lines.push("! *** Repair needed [C-u g] ***");
        pushVec([this.index]);
        pushVec([this.workTree]);
        pushVec(this.popped);
        return lines.join("\n") + "\n--\n";
    }
}

class StgitExtension {
    static instance: StgitExtension | null;
    private stgit: Stgit | undefined;
    private changeEmitter = new vscode.EventEmitter<Uri>();
    private channel = vscode.window.createOutputChannel('stgit');
    private commentController = vscode.comments.createCommentController(
        'stgit.comments', "StGit");

    constructor(context: vscode.ExtensionContext) {
        const provider: vscode.TextDocumentContentProvider = {
            onDidChange: this.changeEmitter.event,
            provideTextDocumentContent: (uri: vscode.Uri, token) => {
                return this.stgit?.documentContents ?? "";
            }
        };
        const blobProvider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri, token) => {
                return this.stgit?.provideTextBlob(uri) ?? "";
            }
        };
        const diffProvider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri, token) => {
                return this.stgit?.provideDiff(uri) ?? "";
            }
        };
        const subscriptions = context.subscriptions;
        subscriptions.push(
            workspace.registerTextDocumentContentProvider('stgit', provider),
            workspace.registerTextDocumentContentProvider(
                'stgit-blob', blobProvider),
            workspace.registerTextDocumentContentProvider(
                'stgit-diff', diffProvider),
        );
        function cmd(cmd: string, func: () => void) {
            return commands.registerTextEditorCommand(`stgit.${cmd}`, func);
        }
        function globalCmd(cmd: string, func: () => void) {
            return commands.registerCommand(`stgit.${cmd}`, func);
        }
        subscriptions.push(
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
            cmd('setHistorySize', () => this.stgit?.setHistorySize()),
            cmd('commitOrUncommitPatches',
                () => this.stgit?.commitOrUncommitPatches()),
            cmd('revertChanges', () => this.stgit?.revertChanges()),
            cmd('undo', () => this.stgit?.undo()),
            cmd('hardUndo', () => this.stgit?.hardUndo()),
            cmd('redo', () => this.stgit?.redo()),
            cmd('help', () => this.stgit?.help()),
        );
        subscriptions.push(
            window.onDidChangeVisibleTextEditors(editors => {
                for (const e of editors) {
                    if (e.document.uri.scheme === 'stgit')
                        this.configureEditor(e);
                }
            }, context.subscriptions)
        );
        context.subscriptions.push(this);
        this.openStgit();
    }
    dispose() {
        this.stgit?.dispose();
        this.channel.dispose();
        this.commentController.dispose();
        this.changeEmitter.dispose();
    }
    private openStgit() {
        if (this.stgit) {
            this.stgit.focusWindow();
            this.stgit.reload();
        } else {
            const theDoc = vscode.workspace.openTextDocument(this.uri);
            theDoc.then((doc) => {
                this.stgit = new Stgit(
                    doc, () => this.notifyDirty(), this.commentController);
                vscode.window.showTextDocument(doc, {
                    viewColumn: this.stgit.mainViewColumn,
                    preview: false,
                });
            });
        }
    }
    private get uri() {
        return vscode.Uri.from({scheme: "stgit", path: "/StGit"});
    }
    private configureEditor(editor: vscode.TextEditor) {
        const opts = editor.options;
        opts.lineNumbers = vscode.TextEditorLineNumbersStyle.Off;
        opts.cursorStyle = vscode.TextEditorCursorStyle.Block;
    }
    notifyDirty() {
        this.changeEmitter.fire(this.uri);
    }
    log(line: any): void {
        this.channel.appendLine(line);
    }
}

function notifyDirty() {
    StgitExtension.instance?.notifyDirty();
}
function log(obj: any) {
    StgitExtension.instance?.log(obj);
}
function info(msg: string) {
    window.showInformationMessage(msg);
}

export function activate(context: vscode.ExtensionContext) {
    StgitExtension.instance = new StgitExtension(context);
}
export function deactivate() {
    StgitExtension.instance = null;
}
