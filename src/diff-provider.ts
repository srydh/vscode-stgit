// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace, commands, window } from 'vscode';
import { info } from './extension';
import { run, runCommand } from './util';

class DiffProvider {
    static instance: DiffProvider | null = null;
    readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

    constructor(context: vscode.ExtensionContext) {
        const diffProvider: vscode.TextDocumentContentProvider = {
            onDidChange: this.changeEmitter.event,
            provideTextDocumentContent: (uri, token) => {
                return DiffProvider.instance?.provideDiff(uri) ?? "";
            }
        };
        const blobProvider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri, token) => {
                return DiffProvider.instance?.provideTextBlob(uri) ?? "";
            }
        };
        function cmd(cmd: string, func: () => void) {
            return commands.registerTextEditorCommand(`sdiff.${cmd}`, func);
        }
        context.subscriptions.push(
            this,
            workspace.registerTextDocumentContentProvider(
                'stgit-diff', diffProvider),
            workspace.registerTextDocumentContentProvider(
                'stgit-blob', blobProvider),

            cmd('openCurrentFileDiff', () => this.openCurrentFileDiff()),
        );
    }
    dispose() {
        this.changeEmitter.dispose();
        DiffProvider.instance = null;
    }
    async openCurrentFileDiff() {
        const editor = window.activeTextEditor;
        if (!editor)
            return;
        const path = workspace.asRelativePath(editor.document.uri);
        const uri = vscode.Uri.parse(`stgit-diff:///diff-${path}#file=${path}`);
        refreshDiff(uri);
        const result = await runCommand('git', ['diff', '--quiet', '--', path]);
        if (!result.ecode) {
            const r2 = await runCommand(
                'git', ['ls-files', '--error-unmatch', '--', path]);
            if (r2.ecode)
                info(`'${path}' is not under version control`);
            else
                info(`'${path}' is unmodified`);
        } else {
            openAndShowDiffDocument(uri);
        }
    }

    provideTextBlob(uri: vscode.Uri): Promise<string> {
        const sha = uri.fragment;
        return run('git', ['show', sha], {trim: false});
    }
    private fixHunkNumbering(lines: string[], hunkStart: number) {
        const REGEXP = /@@ [-]([0-9]*),[0-9]* [+]([0-9]*),[0-9]* @@(.*)/;
        const matches = lines[hunkStart].match(REGEXP);
        if (!matches)
            return;
        const fStart = parseInt(matches[1]);
        const tStart = parseInt(matches[2]);
        const rest = matches[3];

        let fCnt = 0;
        let tCnt = 0;
        for (let [i, done] = [hunkStart + 1, false]; !done; i++) {
            switch (lines[i]?.[0]) {
            case ' ': fCnt++; tCnt++; break;
            case '+': tCnt++; break;
            case '-': fCnt++; break;
            case '@':
                if (lines[i] == '@#') {
                    const spec = `-${fStart + fCnt},0 +${tStart + tCnt},0`;
                    lines[i] = `@@ ${spec} @@`;
                }
                done = true;
                break;
            default:
                done = true;
                break;
            }
        }
        lines[hunkStart] = `@@ -${fStart},${fCnt} +${tStart},${tCnt} @@${rest}`;
    }
    private applyHunkSplitting(diff: string, splitSpec?: string): string {
        if (!splitSpec)
            return diff;
        const splits = splitSpec.split(';').map(x => parseInt(x));
        const diffLines = diff.split('\n');
        splits.forEach(n => diffLines.splice(n, 0, "@#"));

        diffLines.forEach((s, i) => {
            if (s.startsWith("@@"))
                this.fixHunkNumbering(diffLines, i);
        });

        return diffLines.join('\n');
    }
    async provideDiff(uri: vscode.Uri): Promise<string> {
        const args = uri.fragment.split(',').map(
            s => (s + "=").split("=", 2) as [string, string]);
        const d = new Map(args);
        const diffArgs: string[] = [];
        const index = d.has('index');
        const sha = d.get('sha');
        const file = d.get('file');
        const splits = d.get('splits');
        const diffmode = d.get('diffmode');
        const noTrim = {trim: false};
        let header: Promise<string> | null = null;
        if (file && diffmode) {
            switch (diffmode) {
            case '13':
                diffArgs.push(`:1:${file}`, `:3:${file}`);
                break;
            case '12':
                diffArgs.push(`:1:${file}`, `:2:${file}`);
                break;
            case '2':
                diffArgs.push('-2', '--', file);
                break;
            case '3':
                diffArgs.push('-3', '--', file);
                break;
            default:
                return "* bad diff mode";
            }
        } else {
            if (index)
                diffArgs.push('--cached');
            else if (sha)
                diffArgs.push(`${sha}^`, sha);
            else
                diffArgs.push('-2');
            if (sha && !file)
                header = run('git', ['show', '--stat', sha], noTrim);
            if (file)
                diffArgs.push('--', file);
        }
        const diff = await run('git', ['diff', ...diffArgs], noTrim);
        const contents = header ? [await header, diff].join("\n") : diff;
        return this.applyHunkSplitting(contents, splits);
    }
}

export async function openAndShowDiffDocument(
    uri: vscode.Uri, opts?: vscode.TextDocumentShowOptions
) {
    const doc = await workspace.openTextDocument(uri);
    const newDoc = await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    window.showTextDocument(newDoc, {preview: true, ...opts});
    return newDoc;
}

export function refreshDiff(uri: vscode.Uri) {
    DiffProvider.instance?.changeEmitter.fire(uri);
}

export function registerDiffProvider(context: vscode.ExtensionContext) {
    DiffProvider.instance = new DiffProvider(context);
}
