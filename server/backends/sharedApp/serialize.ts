// One at a time, per thing.
//
// Two chains are kept with this: `app.json` writes (so a read-modify-write cannot lose the other
// half) and whole shared-app OPERATIONS (so one operation cannot land in the middle of another).
// They are the same mechanism because they are the same problem — a sequence of reads and writes
// that is only correct if nothing interleaves with it — and having one implementation is what
// keeps a second one from being written with the subtle parts left out.
//
// In-process is the honest scope, and it is the scope of the problem: MulmoTerminal is ONE server
// and every cell's tool call runs in it, so "two cells at once" is how this happens. Two separate
// servers over one checkout would still race, and a lock file is what that would need — not
// written, because nothing here can produce that arrangement.
//
// Keys are PREFIXED by what they name (`manifest:` / `operation:`), because the two namespaces
// overlap in the obvious spelling and an operation waiting on its own manifest write would be a
// deadlock rather than a bug you can see.
const chains = new Map<string, Promise<unknown>>();

export function serializeBy<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // `catch` before `then`: a rejected predecessor must not reject its successor, and a settled
  // chain is the only thing this needs from it.
  const next = previous.catch(() => {}).then(run);
  chains.set(key, next);
  // Dropped when the last waiter settles, so the map does not grow with every project ever
  // published.
  void next
    .catch(() => {})
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  return next;
}
