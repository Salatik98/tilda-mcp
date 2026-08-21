import { describe, expect, it } from "vitest";
import type { AccountInventory } from "../../src/research/inventory.js";
import {
  TARGET_DISCOVERY_LIMITS,
  TargetDiscoveryError,
  deriveProjectPageInventory,
  validateProjectInventoryForDiscovery,
  type ProjectPageDiscoveryProbe,
} from "../../src/research/target-discovery.js";

function accountInventory(
  projects: AccountInventory["projects"] = [
    { id: "22", title: "  Main\n Site  ", hrefPath: "/projects/", source: "dom" },
    { id: "3", title: "Lab", hrefPath: "/projects/", source: "dom" },
  ],
): AccountInventory {
  return {
    status: "INVENTORIED",
    capturedAt: "2026-08-20T04:00:00.000Z",
    source: "authorized_editor_dom",
    route: "/projects/",
    projects,
    warnings: [],
    privacy: {
      containsSecrets: false,
      containsLeadsOrdersOrCustomerPii: false,
    },
  };
}

function pageProbe(
  overrides: Partial<ProjectPageDiscoveryProbe> = {},
): ProjectPageDiscoveryProbe {
  return {
    host: "tilda.ru",
    route: "/projects/",
    href: "https://tilda.ru/projects/?projectid=22",
    authenticated: true,
    uiReady: true,
    projectId: "22",
    pages: [
      {
        id: "901",
        title: "  Landing\n\u202e page  ",
        hrefPath: "/untrusted/ignored",
        source: "dom",
      },
      { id: "80", title: null, hrefPath: "https://evil.test/", source: "dom" },
    ],
    pageCardCount: 2,
    expectedPageCount: 2,
    paginationDetected: false,
    failures: [],
    ...overrides,
  };
}

describe("bounded Tilda target discovery", () => {
  it("normalizes project labels and emits only canonical same-origin routes", () => {
    const result = validateProjectInventoryForDiscovery(accountInventory());

    expect(result.projects).toEqual([
      { id: "3", title: "Lab", hrefPath: "/projects/?projectid=3", source: "dom" },
      { id: "22", title: "Main Site", hrefPath: "/projects/?projectid=22", source: "dom" },
    ]);
    expect(result.privacy).toEqual({
      containsSecrets: false,
      containsLeadsOrdersOrCustomerPii: false,
    });
  });

  it("derives a bounded canonical page inventory without trusting DOM hrefs", () => {
    const result = deriveProjectPageInventory(
      pageProbe(),
      "22",
      "2026-08-20T04:00:00.000Z",
    );

    expect(result).toMatchObject({
      status: "INVENTORIED",
      projectId: "22",
      pages: [
        { id: "80", title: null, hrefPath: "/page/?pageid=80&projectid=22" },
        { id: "901", title: "Landing page", hrefPath: "/page/?pageid=901&projectid=22" },
      ],
      privacy: {
        containsSecrets: false,
        containsLeadsOrdersOrCustomerPii: false,
        pageContentRead: false,
        browserStatePersisted: false,
      },
    });
    expect(result.warnings).toEqual(["Some page titles were absent from the rendered project cards."]);
    expect(JSON.stringify(result)).not.toContain("evil.test");
    expect(JSON.stringify(result)).not.toContain("untrusted/ignored");
  });

  it("fails closed on wrong routes, unauthenticated UI, pagination, or ambiguous counts", () => {
    const cases: ProjectPageDiscoveryProbe[] = [
      pageProbe({ href: "https://tilda.ru/projects/?projectid=23" }),
      pageProbe({ authenticated: false }),
      pageProbe({ paginationDetected: true }),
      pageProbe({ pageCardCount: 3 }),
      pageProbe({ expectedPageCount: 3 }),
      pageProbe({ failures: ["PAGE_CARD_IDENTITY_AMBIGUOUS"] }),
    ];

    for (const probe of cases) {
      expect(() => deriveProjectPageInventory(probe, "22")).toThrow(TargetDiscoveryError);
    }
  });

  it("rejects duplicate IDs and inventories over the hard bound", () => {
    expect(() => validateProjectInventoryForDiscovery(accountInventory([
      { id: "3", title: "One", hrefPath: null, source: "dom" },
      { id: "3", title: "Two", hrefPath: null, source: "dom" },
    ]))).toThrowError(expect.objectContaining({ code: "DISCOVERY_IDENTITY_AMBIGUOUS" }));

    const tooMany = Array.from({ length: TARGET_DISCOVERY_LIMITS.projects + 1 }, (_, index) => ({
      id: String(index + 1),
      title: null,
      hrefPath: null,
      source: "dom" as const,
    }));
    expect(() => validateProjectInventoryForDiscovery(accountInventory(tooMany)))
      .toThrowError(expect.objectContaining({ code: "DISCOVERY_LIMIT_EXCEEDED" }));
  });
});
