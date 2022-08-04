// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, commands, window } from 'vscode';
import { log, info } from './extension';

class DiffHeader {
    constructor(
        public readonly fromPath: string,
        public readonly toPath: string,
    ) {}

    static fromLine(
        doc: vscode.TextDocument,
        line: number
    ): DiffHeader | null {
        let start = line;
        for (; start >= 0; start--) {
            if (doc.lineAt(start).text.startsWith("--- "))
                break;
        }
        if (start < 0)
            return null;
        const fromStr = doc.lineAt(start).text;
        const toStr = doc.lineAt(start + 1).text;
        if (!toStr.startsWith("+++ "))
            return null;

        function stripPath(path: string) {
            const s = path.slice(4);
            if (!s.startsWith("/"))
                return s.slice(s.indexOf("/") + 1);
            return path;
        }
        const fromPath = stripPath(fromStr);
        const toPath = stripPath(toStr);

        return new DiffHeader(fromPath, toPath);
    }
}

class HunkText {
    constructor(
        public readonly srcLine: number,
        public readonly text: string[],
        public readonly numDiffLines: number,
    ) {}

    static fromSpec(
        doc: vscode.TextDocument,
        spec: string,
        line: number
    ): HunkText | null {
        const marker = spec[0];
        if (marker !== '-' && marker !== '+')
            return null;
        const [lineStr, countStr] = spec.slice(1).split(",");
        const srcLine = parseInt(lineStr) - 1;
        let numLines = parseInt(countStr);

        const lines: string[] = [];
        let i = 0;
        for (; numLines > 0; i++) {
            if (line + 1 + i >= doc.lineCount)
                return null;
            const s = doc.lineAt(line + 1 + i).text;
            if (s.startsWith(marker) || s.startsWith(' ')) {
                lines.push(s.slice(1));
                numLines--;
            } else if (!s.startsWith('-') && !s.startsWith('+')) {
                return null;
            }
        }
        return new HunkText(srcLine, lines, i + 1);
    }

    private matchesAtLine(doc: vscode.TextDocument, line: number) {
        if (line + this.text.length >= doc.lineCount)
            return false;
        for (let i = 0; i < this.text.length; i++) {
            if (doc.lineAt(i + line).text !== this.text[i])
                return false;
        }
        return true;
    }

    findInDoc(doc: vscode.TextDocument): number {
        const line = this.srcLine < doc.lineCount ?
            this.srcLine : doc.lineCount - 1;
        if (this.matchesAtLine(doc, line))
            return line;
        for (let offs = 1; ; offs += 1) {
            const upLine = line - offs;
            const downLine = line + offs;
            if (upLine < 0 && downLine >= doc.lineCount)
                return -1;
            if (upLine >= 0 && this.matchesAtLine(doc, upLine))
                return upLine;
            if (downLine < doc.lineCount && this.matchesAtLine(doc, downLine))
                return downLine;
        }
    }
}

class Hunk {
    constructor(
        public readonly line: number,
        public readonly fromText: HunkText,
        public readonly toText: HunkText,
        public readonly numDiffLines: number,
    ) {}

    static fromLine(doc: vscode.TextDocument, line: number): Hunk | null {

        const atStr = doc.lineAt(line).text;
        if (!atStr.startsWith("@@ ") || !atStr.includes("@@", 3))
            return null;

        const [fromSpec, toSpec] = atStr.slice(3).split("@@")[0].split(" ");

        const fromText = HunkText.fromSpec(doc, fromSpec, line);
        const toText = HunkText.fromSpec(doc, toSpec, line);
        if (!fromText || !toText)
            return null;
        const diffLines = Math.max(fromText.numDiffLines, toText.numDiffLines);

        return new Hunk(line, fromText, toText, diffLines);
    }
}

class DiffMode {
    static instance: DiffMode | null;
    constructor(context: vscode.ExtensionContext) {
        function cmd(cmd: string, func: (editor: vscode.TextEditor) => void) {
            return commands.registerTextEditorCommand(`sdiff.${cmd}`, func);
        }
        const subscriptions = context.subscriptions;
        subscriptions.push(
            cmd('applyHunk', () => this.applyHunk()),
            cmd('revertHunk', () => this.revertHunk()),
            cmd('splitHunk', (e) => this.splitHunk(e)),
            cmd('openFile', () => this.openFile()),
            cmd('help', () => this.help()),
            cmd('gotoPreviousHunk', (e) => this.gotoPreviousHunk(e)),
            cmd('gotoNextHunk', (e) => this.gotoNextHunk(e)),
        );
        subscriptions.push(this);
    }
    dispose() {
        DiffMode.instance = null;
    }
    private gotoHunk(editor: vscode.TextEditor, lineIncrement: number) {
        let line = editor.selection.start.line + lineIncrement;
        const lineCount = editor.document.lineCount;
        for (; line >= 0 && line < lineCount; line += lineIncrement) {
            const s = editor.document.lineAt(line);
            if (s.text.startsWith('@@') || line == lineCount - 1) {
                const p = new vscode.Position(line, 0);
                editor.selection = new vscode.Selection(p, p);
                editor.revealRange(new vscode.Range(p, p),
                    vscode.TextEditorRevealType.InCenter);
                break;
            }
        }
    }
    gotoPreviousHunk(editor: vscode.TextEditor) {
        this.gotoHunk(editor, -1);
    }
    gotoNextHunk(editor: vscode.TextEditor) {
        this.gotoHunk(editor, 1);
    }

    private async doApplyHunk(opts: {reverse: boolean}) {
        const hunk = this.hunk;
        if (!hunk)
            return;
        const [fromText, toText] = opts.reverse ?
            [hunk.toText, hunk.fromText] : [hunk.fromText, hunk.toText];
        const doc = await this.getSourceDoc();
        if (doc) {
            const matchLine = fromText.findInDoc(doc);
            if (matchLine < 0) {
                info("Failed to apply hunk");
                return;
            }
            const docEditor = await window.showTextDocument(doc);
            const startPos = new vscode.Position(matchLine, 0);
            const endPos = startPos.translate(fromText.text.length - 1, 9999);
            const range = new vscode.Range(startPos, endPos);
            docEditor.edit((builder) => {
                builder.replace(range, toText.text.join("\n"));
            });
        }
    }
    applyHunk() {
        this.doApplyHunk({reverse: false});
    }
    revertHunk() {
        this.doApplyHunk({reverse: true});
    }
    splitHunk(editor: vscode.TextEditor) {
        log("splitHunk");
    }
    async openFile() {
        const header = this.header;
        if (header) {
            const uri = vscode.Uri.joinPath(this.repoUri, header.toPath);
            const doc = await workspace.openTextDocument(uri);
            window.showTextDocument(doc);
        }
    }
    help() {
        commands.executeCommand(
            "workbench.action.quickOpen", ">SDiff: ");
    }
    async getSourceDoc(): Promise<vscode.TextDocument | null> {
        const header = this.header;
        if (!header)
            return null;
        const uri = vscode.Uri.joinPath(this.repoUri, header.toPath);
        return workspace.openTextDocument(uri);
    }
    private findHunk(doc: vscode.TextDocument, line: number) {
        for (let i = line; i > 0; i--) {
            if (doc.lineAt(i).text.startsWith("@@")) {
                const hunk = Hunk.fromLine(doc, i);
                if (hunk && line < i + hunk.numDiffLines)
                    return hunk;
                return null;
            }
        }
        return null;
    }
    private get hunk(): Hunk | null {
        const editor = window.activeTextEditor;
        if (editor) {
            const line = editor.selection.start.line;
            return this.findHunk(editor.document, line);
        }
        return null;
    }
    private get header(): DiffHeader | null {
        const editor = window.activeTextEditor;
        if (editor) {
            const line = editor.selection.start.line;
            return DiffHeader.fromLine(editor.document, line);
        }
        return null;
    }
    private get repoUri(): vscode.Uri {
        const d = workspace.workspaceFolders?.[0]?.uri;
        return d ? d : vscode.Uri.parse("unknown://repo/path");
    }
}

export function registerDiffMode(context: vscode.ExtensionContext) {
    DiffMode.instance = new DiffMode(context);
}
