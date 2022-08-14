// Copyright (C) 2022, Samuel Rydh <samuelrydh@gmail.com>
// This code is licensed under the BSD 2-Clause license.

import { log } from "./extension";
import { RepositoryInfo } from "./repo";
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
    const repo = await RepositoryInfo.lookup();
    if (!repo)
        return;
    const index = await run('git', ['write-tree']);
    if (index === '')
        return;
    await run('git', ['reset', '--mixed', '-q', 'HEAD']);
    if (files)
        await run('git', ['reset', '-q', 'HEAD^', '--', ...files]);
    else
        await run('git', ['read-tree', 'HEAD^']);

    const version = await getStGitVersion();
    if (version?.startsWith("1")) {
        // Workaround a problem in StGit 1.x where the refresh fails
        // when a file is deleted in the index but present in the work tree.
        await withTempDir(async (tempDir) => {
            const env = {
                GIT_WORK_TREE: tempDir,
                GIT_DIR: repo.gitDir,
            };
            await runCommand('stg', ['refresh', '-i'], {env});
        });
    } else {
        // StGit 2.0+ does not have the issue above. The code above does
        // not work with 2.0+ since GIT_WORK_TREE is unsupported.
        await runCommand('stg', ['refresh', '-i']);
    }
    await run('git', ['read-tree', index]);
}

let stgVersionGetter: Promise<string | null> | null = null;

export function getStGitVersion(): Promise<string | null> {
    async function getter(): Promise<string> {
        const result = await run('stg', ['version', '-s']);
        for (const s of result.split("\n")) {
            if (s.startsWith('Stacked Git '))
                return s.split('\n')[0].replace('Stacked Git ', '').trim();
            if (s.startsWith('stg '))
                return s.replace("stg ", '').trim();
        }
        return "";
    }
    if (!stgVersionGetter)
        stgVersionGetter = getter();
    return stgVersionGetter;
}
