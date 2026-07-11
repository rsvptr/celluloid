// Incremental extraction of completed recommendation objects from a streaming
// JSON response shaped like {"recommendations":[{...},{...},...]}. Pure and
// dependency-free so the parsing logic is unit-testable.

/**
 * Feed text chunks as they stream in; get back each array item the moment its
 * closing brace arrives. Tracks JSON string/escape state so braces inside
 * titles ("{proto}" and friends) can't confuse the depth counter.
 *
 * The structured-output schema guarantees the overall shape, but every slice is
 * still JSON.parse'd defensively — a chunk that doesn't parse is skipped rather
 * than thrown.
 */
export function createRecExtractor(): { push(chunk: string): unknown[] } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let itemStart = -1; // index into `buf` where the current item object began
  let buf = ""; // unconsumed tail (from the start of an in-progress item)

  return {
    push(chunk: string): unknown[] {
      const out: unknown[] = [];
      buf += chunk;
      // Scan only the newly appended region, but indexes are into `buf`.
      let i = buf.length - chunk.length;
      for (; i < buf.length; i++) {
        const c = buf[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') {
          inString = true;
        } else if (c === "{" || c === "[") {
          depth++;
          // Root object = depth 1, recommendations array = depth 2, so each
          // array item opens at the 2 -> 3 transition.
          if (c === "{" && depth === 3 && itemStart === -1) itemStart = i;
        } else if (c === "}" || c === "]") {
          depth--;
          if (c === "}" && depth === 2 && itemStart !== -1) {
            const slice = buf.slice(itemStart, i + 1);
            itemStart = -1;
            try {
              out.push(JSON.parse(slice));
            } catch {
              // malformed slice — skip it rather than kill the stream
            }
          }
        }
      }
      // Drop consumed text to keep memory flat: keep only an in-progress item.
      if (itemStart === -1) {
        buf = "";
      } else if (itemStart > 0) {
        buf = buf.slice(itemStart);
        itemStart = 0;
      }
      return out;
    },
  };
}
