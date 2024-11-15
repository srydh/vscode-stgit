# Change Log

<!--
Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.
-->

## 0.9.8 (2024-11-16)
- Yet another try to workaround the comment editor focus issue

## 0.9.7 (2024-07-18)
- Make the workaround for a comment editor focus issue more robust

## 0.9.6 (2024-07-15)
- Restore functionality of the C-c C-c keyboard shortcut
which dismisses the commit editor and performs the commit. The shortcut was broken by a namechange in the latest VSCode release.
- Add support for creating new branches
- Work around a focus issue with the comment editor

## 0.9.5 (2023-06-08)
- Fix a bug where the upstream setting was not always updated at branch switch

## 0.9.4 (2023-05-31)
- Make all commands show up in the built-in help. Previously,
some commands were missing (like rebase, fetch and push).

## 0.9.3 (2023-05-30)
- Add status bar messages at successful push or fetch
- Get user confirmation before pushing a branch
- Get user confirmation before performing a hard undo

## 0.9.2 (2023-05-29)
- Add support for setting the upstream branch
- Add support for fetch and push operations
- Report all errors also in the log
- Add support for initiating GitHub pull requests after a push

## 0.9.1 (2022-02-08)
- Do not filter StGit error output when using StGit 2.x
- Ignore StGit open key binding when terminal is focused
- Ignore most StGit key bindings when comment editor is open

## 0.9.0 (2022-09-02)
- Support for marking patches modifying the same files as specified file/patch
- Report when a rebase operation is aborted
- The Git history is now given a gray colorization
- Initial implementation
