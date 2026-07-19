// lib/projects.js
//
// Groups per-address burn sources into project umbrellas (e.g. all Claw Fomo
// deploys under one row). Totals are summed; versions stay available for expand.

function groupKey(source) {
  if (source.project) return source.project;
  if (source.name) return source.name;
  return source.addr;
}

function groupSources(sources, registry = {}) {
  const groups = new Map();
  const includedAddresses = new Set();

  for (const source of sources) {
    includedAddresses.add(source.addr);
    const key = groupKey(source);
    let group = groups.get(key);
    if (!group) {
      group = {
        project: key,
        name: source.project || source.name || null,
        category: source.category,
        burned: 0n,
        count: 0,
        unconfirmed: false,
        versions: [],
        first: source.first,
        last: source.last,
      };
      groups.set(key, group);
    }

    group.versions.push(source);
    group.burned += BigInt(source.burned);
    group.count += source.count;
    if (source.unconfirmed) group.unconfirmed = true;
    if (source.first < group.first) group.first = source.first;
    if (source.last > group.last) group.last = source.last;

    // Prefer the more specific labeled category when versions mix.
    if (source.category === "clawdbotatg") group.category = "clawdbotatg";
    else if (source.category === "community" && group.category === "unlabeled") {
      group.category = "community";
    }
  }

  // Include known zero-burn deployments as children of an existing project.
  // This makes umbrellas such as CLAWD DCA show v1/v2/v3 even when only v2
  // has executed an on-chain burn. Do not create standalone zero-burn projects.
  for (const [addr, entry] of Object.entries(registry)) {
    if (includedAddresses.has(addr) || !entry?.project) continue;
    const group = groups.get(entry.project);
    if (!group) continue;
    group.versions.push({
      addr,
      name: entry.name || null,
      project: entry.project,
      category: entry.category || "unlabeled",
      note: entry.note || null,
      count: 0,
      burned: "0",
      first: null,
      last: null,
      unconfirmed: false,
    });
  }

  return [...groups.values()]
    .map(group => {
      const versions = [...group.versions].sort((a, b) =>
        BigInt(b.burned) > BigInt(a.burned) ? 1 : -1
      );
      const primary = versions[0];
      return {
        project: group.project,
        name: group.name,
        category: group.category,
        burned: group.burned.toString(),
        count: group.count,
        unconfirmed: group.unconfirmed,
        first: group.first,
        last: group.last,
        // Single-deploy projects keep a concrete address on the parent row.
        addr: versions.length === 1 ? primary.addr : null,
        versionCount: versions.length,
        versions: versions.length > 1 ? versions : null,
      };
    })
    .sort((a, b) => (BigInt(b.burned) > BigInt(a.burned) ? 1 : -1));
}

module.exports = { groupSources, groupKey };
