export function createConcurrencyLimiter(maxConcurrent) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Concurrency limit must be a positive integer.");
  }

  let active = 0;
  const queue = [];

  return function runLimited(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            queue.shift()?.();
          });
      };

      if (active < maxConcurrent) start();
      else queue.push(start);
    });
  };
}
