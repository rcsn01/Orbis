const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(version) {
  if (typeof version !== "string") return null;
  const match = SEMVER.exec(version);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? []
  };
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) throw new TypeError("Cannot compare invalid semantic versions.");

  for (const key of ["major", "minor", "patch"]) {
    const difference = left[key] - right[key];
    if (difference !== 0) return Math.sign(difference);
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftIsNumber = /^\d+$/.test(leftIdentifier);
    const rightIsNumber = /^\d+$/.test(rightIdentifier);
    if (leftIsNumber && rightIsNumber) {
      return Math.sign(Number(leftIdentifier) - Number(rightIdentifier));
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function latestSemverTag(tags) {
  const semverTags = tags.filter((tag) => tag.startsWith("v") && parseSemver(tag.slice(1)));
  return semverTags.sort((left, right) => compareSemver(right.slice(1), left.slice(1)))[0] ?? null;
}
