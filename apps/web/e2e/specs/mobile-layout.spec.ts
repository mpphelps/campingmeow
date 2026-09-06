import { test, expect } from "../test-fixtures";
import { createPark, createFacility } from "../utilities/utilities";

/**
 * Layout regressions are invisible to every other spec, because Playwright's
 * default viewport is desktop-width. These run at phone size.
 */
const PHONE = { width: 390, height: 844 };

test.describe("mobile header", () => {
  test.use({
    viewport: PHONE,
    user: { email: "mobile@example.com", firstName: "Mo", lastName: "Bile", permissions: ["admin:site"] },
  });

  test("collapses the nav into a drawer instead of cramming it into the bar", async ({ page }) => {
    await page.goto("/");

    // Five inline links plus a greeting have nowhere to go on a phone.
    await expect(page.getByRole("navigation").getByRole("link", { name: "My watches" })).toBeHidden();

    await page.getByRole("button", { name: "Open menu" }).click();

    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("link", { name: "My watches" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Admin" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(drawer.getByText("Signed in as")).toBeVisible();
  });

  test("navigating from the drawer closes it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Settings" }).click();

    await expect(page).toHaveURL(/\/preferences$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the joke still shows, on its own strip", async ({ page }) => {
    await page.goto("/");
    // Rendered twice — inline beside the brand on wide screens, and on its own
    // strip below the bar on narrow ones. Exactly one should ever be visible.
    await expect(page.getByText("Let's go camping right meow.").filter({ visible: true })).toHaveCount(1);
  });
});

test.describe("mobile header — logged out", () => {
  test.use({ viewport: PHONE, user: null });

  test("keeps Log in outside the drawer, and never offers Log out", async ({ page }) => {
    await page.goto("/");

    // One tap, not two: signing in is the thing we want a visitor to do.
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();

    // The drawer exists now that there is a link worth putting in it, but it
    // must not offer to log out someone who was never logged in.
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("link", { name: "Available nearby" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Log out" })).toHaveCount(0);
  });
});

test.describe("mobile park rows", () => {
  test.use({ viewport: PHONE, user: null });

  test("row text never runs underneath the icon links", async ({ page }) => {
    // A long park name with a long city is the case that broke: the metadata
    // was shrink-0 inside a container with no min-w-0, so it overflowed and
    // rendered under the map/park-info icons.
    const park = await createPark({ name: "Anza-Borrego Desert SP", city: "BORREGO SPRINGS" });
    for (let i = 0; i < 6; i++) await createFacility({ name: `Camp ${i}`, parkId: park.id });

    await page.goto("/");

    // Scope to the row: "campgrounds" also appears in the full-width hint line
    // above the list, which would make this assertion meaningless.
    const row = page.locator("[data-slot='accordion-item']").first();
    const meta = row.getByText("campgrounds", { exact: false }).first();
    const icons = row.getByRole("link", { name: /on Google Maps/ });

    const metaBox = await meta.boundingBox();
    const iconBox = await icons.boundingBox();
    expect(metaBox).not.toBeNull();
    expect(iconBox).not.toBeNull();

    // The text must end before the icons begin.
    expect(metaBox!.x + metaBox!.width).toBeLessThanOrEqual(iconBox!.x);
  });

  test("stays within the viewport — no horizontal scroll", async ({ page }) => {
    const park = await createPark({ name: "Big Basin Redwoods SP Tent Cabins", city: "BOULDER CREEK" });
    await createFacility({ name: "Huckleberry Tent Cabins", parkId: park.id });

    await page.goto("/");

    const overflow = await page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");
    expect(overflow).toBe(false);
  });
});
