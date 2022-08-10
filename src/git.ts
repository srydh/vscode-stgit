// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import { log } from "./extension";
import { run, runCommand, withTempDir } from "./util";

export async function updateIndex(
    path: string,
    contents: {data?: string, mode?: string}
) {
    let mode: string | undefined;
    let sha: string | undefined;

    if (contents.data === undefined || contents.mode === undefined) {
        const tree = await run('git', ['write-tree']);
        const info = await run('git', ['ls-tree', tree, '--', path]);
        const re = /([0-9]*) [a-z]* ([a-fA-F0-9]*)/;
        [, mode, sha] = info.match(re) ?? [];
    }
    if (!mode)
        mode = "100644";
    if (contents.data) {
        sha = await run('git', ['hash-object', '-w', '--stdin'], {
            stdin: contents.data ?? ""
        });
    }
    if (!sha) {
        log("updateIndex: !sha");
        return;
    }
    const cacheInfo = [mode, sha, path].join(",");
    await run('git', ['update-index', '--cacheinfo', cacheInfo]);
}

export async function uncommitFiles(files?: string[]) {
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
