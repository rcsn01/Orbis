#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compareSemver, latestSemverTag, parseSemver } from "./release-version.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log("Usage: pnpm release:mac [--dry-run]");
  console.log("Builds a local macOS DMG, pushes main and its version tag, then creates a GitHub Release.");
  process.exit(0);
}
for (const arg of args) {
  if (arg !== "--dry-run") fail(`Unknown option: ${arg}`);
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || !parseSemver(version)) {
  fail("package.json must contain a valid semantic version.");
}

const tag = `v${version}`;
const dmg = join(root, "release", `Orbis-${version}-mac-arm64.dmg`);
const checksum = `${dmg}.sha256`;

if (args.has("--dry-run")) {
  console.log(`Local release dry run for ${tag}`);
  console.log("No commands will be executed and nothing will be packaged, tagged, pushed, or uploaded.");
  console.log(`Artifact: ${dmg}`);
  console.log(`Checksum: ${checksum}`);
  console.log("Actual flow: preflight → package:mac:unsigned → tag → atomic push → GitHub Release upload");
  process.exit(0);
}

if (process.platform !== "darwin") fail("macOS releases must be created on macOS.");
requireCommand("git", ["--version"], "Install Git before creating a release.");
requireCommand("pnpm", ["--version"], "Install pnpm before creating a release.");
requireCommand("gh", ["--version"], "Install GitHub CLI with `brew install gh`, then run `gh auth login`.");
run("gh", ["auth", "status"], "Authenticate GitHub CLI first with `gh auth login`.");

if (capture("git", ["branch", "--show-current"]) !== "main") {
  fail("Releases must be created from the main branch.");
}
if (capture("git", ["status", "--porcelain"])) {
  fail("Commit or discard all working-tree changes before releasing.");
}

run("git", ["fetch", "origin", "main", "--tags"], "Unable to refresh origin/main and release tags.");
run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], "Local main does not contain the latest origin/main. Pull or rebase first.");
const latestTag = latestSemverTag(capture("git", ["tag", "--list", "v*"]).split("\n"));
if (latestTag && compareSemver(version, latestTag.slice(1)) <= 0) {
  fail(`Version ${version} must be greater than the latest release ${latestTag}. Bump package.json before releasing.`);
}
if (succeeds("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) {
  fail(`Tag ${tag} already exists. Bump package.json before releasing again.`);
}
if (succeeds("gh", ["release", "view", tag])) {
  fail(`GitHub Release ${tag} already exists. Bump package.json before releasing again.`);
}

console.log(`Building ${tag} locally...`);
run("pnpm", ["package:mac:unsigned"], "macOS packaging failed.");
await access(dmg).catch(() => fail(`Expected DMG was not produced: ${dmg}`));

const digest = await sha256(dmg);
await writeFile(checksum, `${digest}  ${basename(dmg)}\n`, "utf8");
console.log(`Created ${basename(checksum)}.`);

run("git", ["tag", "-a", tag, "-m", `Orbis ${version}`], `Unable to create tag ${tag}.`);
console.log("Pushing main and the release tag; the local pre-push checks will run now...");
const push = spawnSync(
  "git",
  ["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `refs/tags/${tag}:refs/tags/${tag}`],
  { cwd: root, stdio: "inherit" }
);
if (push.error || push.status !== 0) {
  spawnSync("git", ["tag", "-d", tag], { cwd: root, stdio: "ignore" });
  fail("Push was rejected. The temporary local tag was removed and no GitHub Release was created.");
}

console.log(`Uploading ${basename(dmg)} to GitHub Releases...`);
const release = spawnSync(
  "gh",
  ["release", "create", tag, dmg, checksum, "--verify-tag", "--generate-notes", "--title", `Orbis ${version}`],
  { cwd: root, stdio: "inherit" }
);
if (release.status !== 0) {
  console.error("The commit and tag were pushed, but the GitHub Release upload failed.");
  console.error(`Retry with: gh release create ${tag} "${dmg}" "${checksum}" --verify-tag --generate-notes --title "Orbis ${version}"`);
  process.exit(release.status ?? 1);
}

console.log(`Published Orbis ${version}.`);

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`Command failed: ${command} ${commandArgs.join(" ")}`);
  return result.stdout.trim();
}

function succeeds(command, commandArgs) {
  return spawnSync(command, commandArgs, { cwd: root, stdio: "ignore" }).status === 0;
}

function requireCommand(command, commandArgs, message) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "ignore" });
  if (result.error || result.status !== 0) fail(message);
}

function run(command, commandArgs, message) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) fail(message);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
