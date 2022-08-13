// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { run } from "./util";

export class RepositoryInfo {
    private static repoPromise: Promise<RepositoryInfo | null> | null = null;

    private constructor(
        public readonly gitDir: string,
        public readonly topLevelDir: string,
    ) {}

    getPathUri(path: string): vscode.Uri {
        return vscode.Uri.joinPath(vscode.Uri.file(this.topLevelDir), path);
    }

    private static async findTopLevelDir(path: string) {
        return await run('git', ['rev-parse', '--show-toplevel'], {
            cwd: path,
        });
    }
    private static async findGitDir(path: string) {
        return await run('git', ['rev-parse', '--absolute-git-dir'], {
            cwd: path,
        });
    }
    private static async create() {
        const ws = workspace.workspaceFolders?.[0].uri.path;
        if (ws) {
            const [topDir, gitDir] = await Promise.all([
                this.findTopLevelDir(ws),
                this.findGitDir(ws),
            ]);
            if (topDir && gitDir)
                return new RepositoryInfo(gitDir, topDir);
        }
        return null;
    }
    static lookup(): Promise<RepositoryInfo | null> {
        if (!this.repoPromise)
            this.repoPromise = this.create();
        return this.repoPromise;
    }
}
