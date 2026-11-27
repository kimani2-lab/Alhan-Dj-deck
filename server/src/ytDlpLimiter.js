export function createConcurrencyLimiter(maxConcurrent) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Concurrency limit must be a positive integer.");
  }

  let active = 0;
  const queue = [];

  return function runLimited(task, { priority = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            queue.shift()?.start();
          });
      };

      if (active < maxConcurrent) {
        start();
        return;
      }

      const entry = { start, priority };
      let index = queue.length;
      while (index > 0 && queue[index - 1].priority < priority) {
        index -= 1;
      }
      queue.splice(index, 0, entry);
    });
  };
}
