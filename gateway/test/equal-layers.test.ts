import { test } from "node:test";
import assert from "node:assert/strict";
import { equalLayers } from "../src/providers.ts";

test("equal layer split only for same-memory members", () => {
  assert.equal(equalLayers([{ mem_gb: 16 }, { mem_gb: 16 }, { mem_gb: 16 }, { mem_gb: 16 }]), true);
  assert.equal(equalLayers([{ mem_gb: 16 }, { mem_gb: 16.4 }]), true);
  assert.equal(equalLayers([{ mem_gb: 7.99 }, { mem_gb: 16 }, { mem_gb: 16 }]), false); // RTX 4060 + Macs: Parallax split
  assert.equal(equalLayers([{ mem_gb: 16 }, { mem_gb: null }]), false); // a member has not reported yet
  assert.equal(equalLayers([{ mem_gb: 16 }]), false);
});
