// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import { log } from "./extension";
import { run, runCommand, withTempDir } from "./util";

export async function isUnmerged(path: string) {
    const s = await run('git', ['ls-files', '-s', '-z', '--', path]);
    const re = /[0-9]* [0-9a-f]* ([0-3])/;
    const [, stage] = s.match(re) ?? [];
    return stage && stage !== '0';
}

export async function updateIndex(
    path: string,
    contents: {data?: string, mode?: string}
) {
    let mode: string | undefined;
    let sha: string | undefined;

    if (contents.data === undefined || contents.mode === undefined) {
        const s = await run('git', ['ls-files', '-s', '-z', '--', path]);
        const re = /([0-9]*) ([0-9a-f]*) [0-3]/;
        [, mode, sha] = s.match(re) ?? [];
    }
    if (!mode)
        mode = "100644";
    if (contents.data !== undefined) {
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
