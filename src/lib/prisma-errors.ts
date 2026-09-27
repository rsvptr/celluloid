import { Prisma } from "@/generated/prisma/client";

// Narrow checks for the Prisma errors a benign race raises (PR-10). Each one
// names the model, and a unique violation names its constraint too, so the
// same code from any other write still surfaces. Under a driver adapter,
// Prisma 7 reports the model as meta.modelName and the violated constraint as
// meta.driverAdapterError.cause.constraint. It sets no meta.target.

type ErrorMeta = {
  modelName?: unknown;
  driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
};

function knownError(error: unknown, code: string): ErrorMeta | null {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
    ? ((error.meta ?? {}) as ErrorMeta)
    : null;
}

/** A unique violation (P2002) of the constraint named `constraint` on `model`. */
export function isUniqueViolation(error: unknown, model: string, constraint: string): boolean {
  const meta = knownError(error, "P2002");
  return (
    meta?.modelName === model &&
    meta.driverAdapterError?.cause?.constraint?.index === constraint
  );
}

/** A single-row update or delete (P2025) that found no `model` row to change. */
export function isRecordNotFound(error: unknown, model: string): boolean {
  return knownError(error, "P2025")?.modelName === model;
}
