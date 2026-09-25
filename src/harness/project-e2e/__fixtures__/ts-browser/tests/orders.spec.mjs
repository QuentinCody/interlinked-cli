// R1: a user creates an order through the page. The page's own fetch to
// POST /orders travels through the supervisor's proxy, which is the evidence
// that this browser case reached the OWNED application.
import { expect, test } from "@playwright/test";

test.describe("orders page", () => {
    test("creates an order through the page", async ({ page }) => {
        await page.goto("/");
        await page.fill("#name", "widget");
        await page.click("#create");
        await expect(page.locator("#result")).toHaveText("created 1: widget");
        // R4 read-back (PE-20): the UI's "created" line is not persistence. A fresh navigation to the stored order proves
        // the application saved it; a "return success without saving" defect fails HERE, not at the line above.
        await page.goto("/orders/1");
        await expect(page.locator("body")).toContainText('"name":"widget"');
    });
});
