// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, commands, window } from 'vscode';
import { log, info } from './extension';

function locateLineInDoc(doc: vscode.TextDocument, needle: string,
        metric: (number: number) => number): number | null {
    let [result, lowest]: [number | null, number] = [null, Infinity];
    for (let i = 0; i < doc.lineCount; i++) {
        const m = metric(i);
        if (m < lowest && doc.lineAt(i).text === needle)
            [result, lowest] = [i, m];
    }
    return result;
}

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
        public readonly text: readonly string[],
        public readonly linemap: readonly number[],
        public readonly missingNewline: boolean,
    ) {}

    static fromSpec(
        hunkLines: string[],
        spec: string,
    ): HunkText | null {
        const marker = spec[0];
        if (marker !== '-' && marker !== '+')
            return null;
        const [lineStr, countStr] = spec.slice(1).split(",");
        const srcLine = parseInt(lineStr) - 1;
        const numLines = parseInt(countStr);

        const lines: string[] = [];
        const lineMap: number[] = [];
        let missingNewline = false;
        hunkLines.forEach((s, i) => {
            lineMap.push(lines.length);
            if (s.startsWith(marker) || s.startsWith(' ')) {
                lines.push(s.slice(1));
                if (hunkLines[i + 1]?.startsWith('\\'))
                    missingNewline = true;
            }
        });
        return (numLines === lines.length) ?
            new HunkText(srcLine, lines, lineMap, missingNewline) : null;
    }

    private matchesAtLine(doc: vscode.TextDocument, line: number) {
        if (line < 0 || line + this.text.length > doc.lineCount)
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
            if (this.matchesAtLine(doc, upLine))
                return upLine;
            if (this.matchesAtLine(doc, downLine))
                return downLine;
        }
    }
}

class Hunk {
    constructor(
        public readonly line: number,
        public readonly fromText: HunkText,
        public readonly toText: HunkText,
        public readonly numHunkLines: number,
    ) {}

    static fromLine(doc: vscode.TextDocument, line: number): Hunk | null {

        const atStr = doc.lineAt(line).text;
        if (!atStr.startsWith("@@ ") || !atStr.includes("@@", 3))
            return null;
        const [fromSpec, toSpec] = atStr.slice(3).split("@@")[0].split(" ");

        const hunkLines: string[] = [];
        for (let i = line + 1; i < doc.lineCount; i++) {
            const s = doc.lineAt(i).text;
            if (!s || !'+- \\'.includes(s[0]))
                break;
            hunkLines.push(s);
        }

        const fromText = HunkText.fromSpec(hunkLines, fromSpec);
        const toText = HunkText.fromSpec(hunkLines, toSpec);
        if (!fromText || !toText)
            return null;

        return new Hunk(line, fromText, toText, hunkLines.length + 1);
    }

    locate(doc: vscode.TextDocument) {
        for (const t of [this.fromText, this.toText]) {
            const line = t.findInDoc(doc);
            if (line >= 0)
                return {text: t, line: line};
        }
        return null;
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
            cmd('gotoPreviousHunk', () => this.gotoPreviousHunk()),
            cmd('gotoNextHunk', () => this.gotoNextHunk()),
        );
        subscriptions.push(this);
    }
    dispose() {
        DiffMode.instance = null;
    }
    private gotoHunk(lineIncrement: number) {
        const editor = window.activeTextEditor;
        if (!editor)
            return;
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
    gotoPreviousHunk() {
        this.gotoHunk(-1);
    }
    gotoNextHunk() {
        this.gotoHunk(1);
    }

    private selectHunk(hunk: Hunk) {
        const editor = window.activeTextEditor;
        if (editor)
            editor.selection = new vscode.Selection(hunk.line, 0, hunk.line, 0);
    }

    private async doApplyHunk(opts: {reverse: boolean}) {
        const hunk = this.hunk;
        if (!hunk)
            return;
        this.selectHunk(hunk);
        const [fromText, toText] = opts.reverse ?
            [hunk.toText, hunk.fromText] : [hunk.fromText, hunk.toText];
        const doc = await this.getSourceDoc(hunk);
        if (doc) {
            const matchLine = fromText.findInDoc(doc);
            if (matchLine < 0) {
                if (toText.findInDoc(doc))
                    info("Patch already applied!");
                else
                    info("Failed to apply hunk");
                return;
            }
            this.gotoNextHunk();
            const docEditor = await window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true,
                preview: false,
            });
            const startPos = new vscode.Position(matchLine, 0);
            const endPos = startPos.translate(fromText.text.length, 0);
            const range = new vscode.Range(startPos, endPos);
            docEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            const nl = toText.missingNewline ? "" : "\n";
            docEditor.edit((builder) => {
                builder.replace(range, toText.text.join("\n") + nl);
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
        const hunk = this.hunk;
        const doc = await this.getSourceDoc(hunk);
        if (doc) {
            const match = hunk?.locate(doc);
            const editor = window.activeTextEditor;
            const curLine = editor?.selection.start.line ?? 0;
            let line: number;
            if (match && hunk) {
                // Exact match
                const offs = curLine - 1 - hunk.line;
                line = match.line + (match.text.linemap[offs] ?? 0);
            } else if (editor && hunk) {
                const needle = editor.document.lineAt(curLine).text.slice(1);
                line = locateLineInDoc(doc, needle, x => Math.min(
                    Math.abs(x - hunk.fromText.srcLine),
                    Math.abs(x - hunk.toText.srcLine),
                )) ?? hunk.toText.srcLine;
            } else {
                line = 0;
            }
            window.showTextDocument(doc, {
                selection: new vscode.Range(line, 0, line, 0),
            });
        }
    }
    help() {
        commands.executeCommand(
            "workbench.action.quickOpen", ">SDiff: ");
    }
    async getSourceDoc(hunk: Hunk | null): Promise<vscode.TextDocument | null> {
        const header = this.getHeader(hunk);
        if (!header)
            return null;
        const uri = vscode.Uri.joinPath(this.repoUri, header.toPath);
        return workspace.openTextDocument(uri);
    }
    private findHunk(doc: vscode.TextDocument, line: number) {
        for (let i = line; i >= 0; i--) {
            if (doc.lineAt(i).text.startsWith("@@")) {
                const hunk = Hunk.fromLine(doc, i);
                if (hunk && line < i + hunk.numHunkLines)
                    return hunk;
                break;
            }
        }
        for (let i = line + 1; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.startsWith("@@")) {
                return Hunk.fromLine(doc, i);
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
    private getHeader(hunk: Hunk | null): DiffHeader | null {
        const editor = window.activeTextEditor;
        if (editor) {
            const line = hunk ? hunk.line : editor.selection.start.line;
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
