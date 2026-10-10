import { mkdtemp, mkdir, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { MemoryStore } from "../memory/memory-store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectMemory } from "./project-memory.js";
let root: string, a: string, b: string, store: MemoryStore, memory: ProjectMemory;
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "project-memory-")));
    a = join(root, "a");
    b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    store = new MemoryStore({ dbFile: join(root, "memory.sqlite"), maxEntries: 100, dedup: { enabled: true, fts5Threshold: .85 } });
    memory = new ProjectMemory(store);
});
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
it("keeps identical reviewed facts in different projects separate even when dedup is enabled", async () => {
    const first = await memory.store({ projectDir: a, content: "Use node --test for regression checks.", evidence: "Verified by running the test suite." });
    const second = await memory.store({ projectDir: b, content: "Use node --test for regression checks.", evidence: "Verified by running the test suite." });
    expect(first.id).not.toBe(second.id);
    expect((await memory.recall({ projectDir: a, query: "regression" })).map(x => x.id)).toEqual([first.id]);
    await expect(memory.selected(b, [first.id])).rejects.toThrow("not in this project");
    await expect(memory.forget(b, first.id)).rejects.toThrow("not in this project");
});
it("canonical paths share memory and persistence survives reopening the SQLite store", async () => {
    const alias = join(root, "alias");
    await symlink(a, alias);
    const entry = await memory.store({ projectDir: alias, content: "The local worker queue has two concurrent slots.", evidence: "Gateway slot query returned two slots." });
    expect(entry.workingDir).toBe(a);
    store.close();
    store = new MemoryStore({ dbFile: join(root, "memory.sqlite"), maxEntries: 100 });
    memory = new ProjectMemory(store);
    expect((await memory.recall({ projectDir: a, query: "queue slots" }))[0]?.id).toBe(entry.id);
    expect(await memory.forget(a, entry.id)).toBe(true);
    expect(await memory.recall({ projectDir: a, query: "queue" })).toEqual([]);
});
it("requires provenance and bounds selected memory without accepting unrelated notes", async () => {
    await expect(memory.store({ projectDir: a, content: "Use tests", evidence: "" })).rejects.toThrow("evidence");
    const unreviewed = store.store({ workingDir: a, content: "unreviewed note" });
    await expect(memory.selected(a, [unreviewed.id])).rejects.toThrow("project memory");
    await expect(memory.selected(a, [1, 2, 3, 4, 5, 6])).rejects.toThrow("five");
});
it("shares a git project's memory with linked worktrees", async () => {
    const exec = promisify(execFile);
    await exec("git", ["init", "-q"], { cwd: a });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "initial"], { cwd: a });
    const worktree = join(root, "linked");
    await exec("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: a });
    const entry = await memory.store({ projectDir: worktree, content: "Use the existing tests for this project.", evidence: "Checked the repository test command." });
    expect(entry.workingDir).toBe(a);
    expect((await memory.recall({ projectDir: a, query: "tests" }))[0]?.id).toBe(entry.id);
    await exec("git", ["worktree", "remove", worktree], { cwd: a });
});
it("rejects caller-supplied project identity tags", async () => {
    await expect(memory.store({ projectDir: a, content: "A project fact", evidence: "Checked source", tags: [" PROJECT:someone-else "] })).rejects.toThrow("reserved");
});
