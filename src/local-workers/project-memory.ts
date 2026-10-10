import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { MemoryEntry, MemoryStore } from "../memory/memory-store.js";
import { record } from "./worker-request.js";

const exec = promisify(execFile);
const REVIEWED_TAG = "reviewed-project-memory";

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${field} must contain 1 to ${maximum} characters`);
  }
  return value.trim();
}

/** A linked worktree and its original checkout share the same project memory. */
export async function canonicalProjectDir(value: unknown): Promise<string> {
  const path = text(value, "projectDir", 4096);
  if (!isAbsolute(path)) throw new Error("projectDir must be an absolute path on the hub");
  const directory = await realpath(path);
  if (!(await stat(directory)).isDirectory()) throw new Error("projectDir must be a directory");
  try {
    const result = await exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: directory, timeout: 5000 });
    const first = result.stdout.split("\0").find(line => line.startsWith("worktree "));
    return first ? await realpath(first.slice("worktree ".length)) : directory;
  } catch (error) {
    if ((error as { code?: unknown }).code === 128) return directory;
    throw error;
  }
}

function projectTag(directory: string): string {
  return "project:" + createHash("sha256").update(directory).digest("hex").slice(0, 32);
}

function validId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("memory id must be a positive integer");
  return value;
}

/** Reuses the hub's notes store while keeping reviewed project facts scoped. */
export class ProjectMemory {
  constructor(private readonly notes: MemoryStore) {}

  async store(raw: unknown): Promise<MemoryEntry> {
    if (!record(raw)) throw new Error("Expected a project memory object");
    const directory = await canonicalProjectDir(raw.projectDir);
    const content = text(raw.content, "content", 3000);
    const evidence = text(raw.evidence, "evidence", 800);
    const tags = raw.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 14 || !tags.every(tag => typeof tag === "string" && tag.length > 0 && tag.length <= 40 && !tag.trim().toLowerCase().startsWith("project:"))) {
      throw new Error("tags must contain at most 14 strings of 1 to 40 characters; project: tags are reserved");
    }
    // Project identity also participates in dedup, which otherwise considers
    // matching content from all projects before checking the candidate's tags.
    return this.notes.store({
      content: content + "\n\nEvidence: " + evidence,
      workingDir: directory,
      source: "agent",
      tags: [REVIEWED_TAG, projectTag(directory), ...tags],
    });
  }

  async recall(raw: unknown): Promise<MemoryEntry[]> {
    if (!record(raw)) throw new Error("Expected a project memory query");
    const directory = await canonicalProjectDir(raw.projectDir);
    const limit = raw.limit ?? 5;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("limit must be from 1 to 10");
    const tags = [REVIEWED_TAG, projectTag(directory)];
    if (raw.query !== undefined && raw.query !== "") {
      return this.notes.recall(text(raw.query, "query", 500), { scope: "project", workingDir: directory, tags, k: limit });
    }
    return this.notes.list({ scope: "project", workingDir: directory, limit: 200, excludeArchived: true })
      .filter(entry => tags.every(tag => entry.tags.includes(tag))).slice(0, limit);
  }

  async selected(projectDir: string, value: unknown): Promise<MemoryEntry[]> {
    if (!Array.isArray(value) || value.length > 5) throw new Error("Select at most five project memory ids");
    const ids = [...new Set(value.map(validId))];
    if (ids.length === 0) return [];
    const directory = await canonicalProjectDir(projectDir);
    return ids.map(id => this.get(directory, id));
  }

  async forget(projectDir: string, id: number): Promise<boolean> {
    const directory = await canonicalProjectDir(projectDir);
    this.get(directory, validId(id));
    return this.notes.remove(id);
  }

  private get(directory: string, id: number): MemoryEntry {
    const entry = this.notes.get(id);
    if (!entry || entry.workingDir !== directory) throw new Error("Memory is not in this project");
    if (!entry.tags.includes(REVIEWED_TAG) || !entry.tags.includes(projectTag(directory))) throw new Error("This note is not reviewed project memory");
    return entry;
  }
}
