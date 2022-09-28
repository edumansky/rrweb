import type {
  addedNodeMutation,
  eventWithTime,
  mousePosition,
} from 'rrweb/typings/types';
import { IncrementalSource } from 'rrweb';
import { EventType, SyncReplayer } from 'rrweb';
import snapshot from './snapshot';
import { serializedNodeWithId } from 'rrweb-snapshot';
type CutterConfig = {
  points: number[];
};

export function sessionCut(
  events: eventWithTime[],
  config: CutterConfig,
): eventWithTime[][] {
  // Events length is too short so that cutting process is not needed.
  if (events.length < 2) return [events];
  const { points } = config;
  if (!points || points.length == 0) return [events];

  events = events.sort((a1, a2) => a1.timestamp - a2.timestamp);
  const totalTime = events[events.length - 1].timestamp - events[0].timestamp;

  const validSortedPoints = getValidSortedPoints(points, totalTime);
  if (validSortedPoints.length < 1) return [events];
  const results: eventWithTime[][] = [];
  const replayer = new SyncReplayer(events);
  let cutPointIndex = 0;
  const baseTime = events[0].timestamp;
  const validSortedTimestamp = validSortedPoints.map(
    (point) => baseTime + point,
  );
  replayer.play(({ index, event }) => {
    if (
      event.timestamp <= validSortedTimestamp[cutPointIndex] &&
      index + 1 < events.length
    ) {
      const nextEvent = events[index + 1];
      while (
        cutPointIndex < validSortedTimestamp.length &&
        nextEvent.timestamp > validSortedTimestamp[cutPointIndex]
      ) {
        if (results.length === 0) {
          results.push(events.slice(0, index + 1));
        }
        cutPointIndex++;
        const nextCutTimestamp =
          cutPointIndex < validSortedPoints.length
            ? validSortedTimestamp[cutPointIndex]
            : events[events.length - 1].timestamp;
        const result = cutEvents(
          events.slice(index + 1),
          replayer,
          event.timestamp,
          nextCutTimestamp,
        );
        results.push(result);
      }
      return cutPointIndex < validSortedTimestamp.length;
    }
    return false;
  });
  return results;
}

function cutEvents(
  events: eventWithTime[],
  replayer: SyncReplayer,
  currentTimestamp: number,
  endTimestamp: number,
) {
  const result: eventWithTime[] = [];
  if (replayer.latestMetaEvent) {
    const metaEvent = replayer.latestMetaEvent;
    metaEvent.timestamp = currentTimestamp;
    result.push(metaEvent);
  }
  result.push(
    ...replayer.unhandledEvents.map((e) => {
      e.timestamp = currentTimestamp + 10;
      return e;
    }),
  );
  const fullSnapshot = snapshot(replayer.virtualDom, {
    mirror: replayer.getMirror(),
  });
  if (fullSnapshot)
    result.push({
      type: EventType.FullSnapshot,
      data: {
        node: fullSnapshot,
        initialOffset: {
          top: 0,
          left: 0,
        },
      },
      timestamp: currentTimestamp,
    });
  result.push(...events.filter((event) => event.timestamp <= endTimestamp));
  return result;
}

export function pruneBranches(
  events: eventWithTime[],
  { keep }: { keep: number[] },
): eventWithTime[] {
  const result: eventWithTime[] = [];
  const replayer = new SyncReplayer(events);
  const treeSet = new Set<number>(keep);
  replayer.reversePlay(({ event }) => {
    if (event.type === EventType.FullSnapshot) {
      const { node } = event.data;
      treeSet.forEach((id) => {
        const tree = getTreeForId(id, node, keep.includes(id));
        tree.forEach((id) => treeSet.add(id));
      });
    } else if (event.type === EventType.IncrementalSnapshot) {
      if (event.data.source === IncrementalSource.Mutation) {
        const { adds } = event.data;
        adds.forEach((add) => {
          if (treeSet.has(add.node.id)) {
            const tree = getTreeForId(
              add.node.id,
              add.node,
              keep.includes(add.node.id),
            );
            treeSet.add(add.parentId);
            tree.forEach((id) => treeSet.add(id));
          } else if (
            'childNodes' in add.node &&
            add.node.childNodes.length > 0
          ) {
            treeSet.forEach((id) => {
              const tree = getTreeForId(id, add.node, keep.includes(id));
              if (tree.length) treeSet.add(add.parentId);
              tree.forEach((id) => treeSet.add(id));
            });
          }
        });
      }
    }
    return true;
  });

  replayer.play(({ event }) => {
    if (
      [EventType.Meta, EventType.Load, EventType.DomContentLoaded].includes(
        event.type,
      )
    ) {
      result.push(event);
    } else if (event.type === EventType.FullSnapshot) {
      const { node } = event.data;
      const prunedNode = reconstructTreeWithIds(node, treeSet);
      if (prunedNode)
        result.push({
          ...event,
          data: {
            ...event.data,
            node: prunedNode,
          },
        } as eventWithTime);
    } else if (event.type === EventType.IncrementalSnapshot) {
      if ('positions' in event.data) {
        const { positions } = event.data;
        const prunedPositions: mousePosition[] = positions.filter((p) =>
          treeSet.has(p.id),
        );
        if (prunedPositions.length > 0)
          result.push({
            ...event,
            data: {
              ...event.data,
              positions: prunedPositions,
            },
          } as eventWithTime);
      } else if ('id' in event.data) {
        if (treeSet.has(event.data.id)) result.push(event);
      } else if (event.data.source === IncrementalSource.Mutation) {
        const { removes, adds, texts, attributes } = event.data;
        const prunedRemoves = removes.filter((remove) =>
          treeSet.has(remove.id),
        );
        const prunedAdds = adds
          .map((add) =>
            treeSet.has(add.parentId) && keep.includes(add.parentId)
              ? add
              : {
                  ...add,
                  node: reconstructTreeWithIds(add.node, treeSet),
                },
          )
          .filter((add) => Boolean(add.node)) as addedNodeMutation[];
        const prunedTexts = texts.filter((text) => treeSet.has(text.id));
        const prunedAttributes = attributes.filter((attr) =>
          treeSet.has(attr.id),
        );
        if (
          prunedRemoves.length > 0 ||
          prunedAdds.length > 0 ||
          prunedTexts.length > 0 ||
          prunedAttributes.length > 0
        )
          result.push({
            ...event,
            data: {
              ...event.data,
              removes: prunedRemoves,
              adds: prunedAdds,
              texts: prunedTexts,
              attributes: prunedAttributes,
            },
          } as eventWithTime);
      }
    }
    return true;
  });
  return result;
}

export function getTreeForId(
  id: number,
  node: serializedNodeWithId,
  includeChildren: boolean,
): number[] {
  const results: number[] = [];
  if (node.id === id) {
    results.push(...getIdsInNode(node, includeChildren));
  } else if ('childNodes' in node) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      const childTree = getTreeForId(id, child, includeChildren);
      if (childTree.length > 0) {
        results.push(node.id, ...childTree);
        break;
      }
    }
  }
  return results;
}

export function getIdsInNode(
  node: serializedNodeWithId,
  includeChildren: boolean,
): Array<number> {
  const results: number[] = [];
  results.push(node.id);
  if (includeChildren && 'childNodes' in node) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      results.push(...getIdsInNode(child, includeChildren));
    }
  }
  return results;
}

export function reconstructTreeWithIds(
  node: serializedNodeWithId,
  ids: Set<number>,
): serializedNodeWithId | undefined {
  if (ids.has(node.id)) {
    if ('childNodes' in node) {
      node.childNodes = node.childNodes
        .map((child) => reconstructTreeWithIds(child, ids))
        .filter(Boolean) as serializedNodeWithId[];
    }
    return node;
  }
  return undefined;
}

export function getValidSortedPoints(points: number[], totalTime: number) {
  const validSortedPoints = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point <= 0 || point >= totalTime) continue;
    validSortedPoints.push(point);
  }
  return validSortedPoints.sort();
}