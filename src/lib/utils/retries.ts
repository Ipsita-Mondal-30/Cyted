export async function withRetries<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label = "operation"
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const delayMs = Math.min(1000 * 2 ** attempt, 8000);
      console.warn(
        `[retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms`,
        error instanceof Error ? error.message : error
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${maxRetries + 1} attempts`);
}
