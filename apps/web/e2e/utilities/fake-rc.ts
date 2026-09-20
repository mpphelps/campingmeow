import { createServer, type Server } from "node:http";

/**
 * A stand-in for ReserveCalifornia's availability grid, for tests that need to
 * drive a real scan.
 *
 * It exists because the real API is not deterministic: measured 2026-09-19,
 * about one response in eight reported a whole block of booked sites as free.
 * That is impossible to reproduce against the live service and is exactly what
 * the confirmation step defends against, so the fake can be told to lie on a
 * chosen read.
 *
 * The web server under test stays `RC_API_OFFLINE=1`; only the test process
 * talks to this, via `RC_BASE_URL` in `.env.test`.
 */

const PORT = 8901;
const UNIT_ID = 50001;
const UNIT_NAME = "Beach Dorm (4 ppl) #38B";

export interface FakeRc {
  /**
   * What each read returns, in order; the last entry repeats.
   *
   * `reported` is every night a slice comes back for — absence is meaningful,
   * since RC omits nights a site is not offered for. `free` must be a subset.
   * A read whose `reported` includes nights the healthy read omits is exactly
   * the fabrication we are defending against.
   */
  setReads(reads: { reported: string[]; free: string[] }[]): void;
  /** How many grid requests have been served. */
  readonly requests: number;
  close(): Promise<void>;
}

export async function startFakeRc(): Promise<FakeRc> {
  let reads: { reported: string[]; free: string[] }[] = [{ reported: [], free: [] }];
  let readIndex = -1;
  let requests = 0;
  // One read is several paged requests, so the answer only advances when a
  // request starts a new page-one.
  let pagesLeft = 0;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const { StartDate } = JSON.parse(body || "{}");
      if (pagesLeft <= 0) {
        readIndex = Math.min(readIndex + 1, reads.length - 1);
        pagesLeft = 4;
      }
      pagesLeft--;

      const read = reads[Math.max(readIndex, 0)] ?? { reported: [], free: [] };
      const reported = new Set(read.reported);
      const free = new Set(read.free);
      const start = new Date(`${StartDate}T00:00:00Z`);
      const slices: Record<string, unknown> = {};
      for (let d = 0; d < 21; d++) {
        const day = new Date(start.getTime() + d * 864e5).toISOString().slice(0, 10);
        // Nights not in `reported` are simply absent, as RC does for a site it
        // is not offering — the response has no key for them at all.
        if (!reported.has(day)) continue;
        slices[`${day}T00:00:00`] = {
          Date: day,
          IsFree: free.has(day),
          IsBlocked: false,
          IsWalkin: false,
          MinStay: 1,
        };
      }
      const end = new Date(start.getTime() + 20 * 864e5).toISOString().slice(0, 10);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          Message: "",
          StartDate,
          EndDate: end,
          TodayDate: new Date().toISOString().slice(0, 10),
          MinDate: new Date().toISOString().slice(0, 10),
          MaxDate: new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10),
          Facility: {
            FacilityId: 757,
            Name: "Fake Facility",
            Units: {
              [UNIT_ID]: {
                UnitId: UNIT_ID,
                Name: UNIT_NAME,
                ShortName: "38B",
                IsAda: false,
                AllowWebBooking: true,
                IsWebViewable: true,
                UnitCategoryId: 1008,
                VehicleLength: 0,
                Slices: slices,
              },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  return {
    setReads(next: { reported: string[]; free: string[] }[]) {
      reads = next;
      readIndex = -1;
      pagesLeft = 0;
    },
    get requests() {
      return requests;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const FAKE_UNIT_ID = UNIT_ID;
export const FAKE_UNIT_NAME = UNIT_NAME;
