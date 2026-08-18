export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends Error {
  readonly status = 422;
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export function ErrorLookup(status: number): { defaultMicroLabel: string; defaultDescription: string } {
  switch (status) {
    case 404:
      return {
        defaultMicroLabel: "Not found",
        defaultDescription: "We couldn't find that page. It may have moved or been removed from the catalog.",
      };
    case 403:
      return {
        defaultMicroLabel: "Access denied",
        defaultDescription: "You don't have permission to view this.",
      };
    case 422:
      return {
        defaultMicroLabel: "Check your entries",
        defaultDescription: "Some fields need fixing before we can save this.",
      };
    case 500:
      return {
        defaultMicroLabel: "Something went wrong",
        defaultDescription: "We hit an unexpected problem. Try again in a moment.",
      };
    default:
      return {
        defaultMicroLabel: "Something went wrong",
        defaultDescription: "We hit an unexpected problem.",
      };
  }
}
