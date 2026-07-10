import { bench, describe } from "vitest";
import {
  DocumentStore,
  createInitialDocument,
  createRectangle,
  getRenderNodesForArtboard,
  parseDocument,
  type LogoDocument,
  type LogoNode,
} from "../src/index";

/** Fixed-density scenes used for local profiling and comparable CI runners. */
function createFixture(nodeCount: number): LogoDocument {
  const initial = createInitialDocument();
  const artboard = initial.artboards[0]!;
  const columns = Math.ceil(Math.sqrt(nodeCount));
  const nodes: Record<string, LogoNode> = {};
  const nodeIds: string[] = [];

  for (let index = 0; index < nodeCount; index += 1) {
    const id = `fixture-node-${index}`;
    const node = createRectangle({
      x: (index % columns) * 24,
      y: Math.floor(index / columns) * 24,
      fill: index % 2 === 0 ? "#111827" : "#4f6bf6",
    });
    nodes[id] = {
      ...node,
      id,
      name: `Fixture ${index}`,
      width: 20,
      height: 20,
      cornerRadius: index % 5,
    };
    nodeIds.push(id);
  }

  return {
    ...initial,
    id: `fixture-${nodeCount}`,
    name: `${nodeCount.toLocaleString("en-US")} leaf fixture`,
    nodes,
    artboards: [
      {
        ...artboard,
        width: columns * 24,
        height: Math.ceil(nodeCount / columns) * 24,
        nodeIds,
      },
    ],
  };
}

const typical = createFixture(500);
const stress = createFixture(10_000);
const typicalJson = JSON.stringify(typical);
const stressJson = JSON.stringify(stress);
let resultSink = 0;
const typicalUpdates = typical.artboards[0]!.nodeIds.slice(0, 100).map((nodeId) => ({
  nodeId,
  patch: { x: typical.nodes[nodeId]!.x + 1 },
}));

describe("typical logo document (500 leaves)", () => {
  bench("flatten visible scene (cold document revision)", () => {
    resultSink ^= getRenderNodesForArtboard({ ...typical }).length;
  });

  bench("read cached visible scene", () => {
    resultSink ^= getRenderNodesForArtboard(typical).length;
  });

  bench("validate and migrate serialized document", () => {
    parseDocument(JSON.parse(typicalJson));
  });

  bench("commit and undo 100-node transform", () => {
    const store = new DocumentStore(typical);
    store.apply({ type: "update-nodes", updates: typicalUpdates });
    store.undo();
  });
});

describe("stress document (10,000 leaves)", () => {
  bench("flatten visible scene (cold document revision)", () => {
    resultSink ^= getRenderNodesForArtboard({ ...stress }).length;
  });

  bench("read cached visible scene", () => {
    resultSink ^= getRenderNodesForArtboard(stress).length;
  });

  bench(
    "validate and migrate serialized document",
    () => {
      parseDocument(JSON.parse(stressJson));
    },
    { time: 1_000 },
  );
});
