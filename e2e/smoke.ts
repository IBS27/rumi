import { test, expect } from "@playwright/test";

test("guest room editing survives reload and can be deleted", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Open the sample room/ }).click();
  await page
    .getByRole("button", { name: "Products · $0", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Place in room", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Products · $79", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Products · $79", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your sessions" }).click();
  await page
    .getByRole("button", { name: "Delete The corner living room", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Open the sample room/ }),
  ).toBeVisible();
});

test("a downloaded room restores in a browser with empty storage", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Open the sample room/ }).click();
  await page
    .getByRole("button", { name: "Products · $0", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Place in room", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Products · $79", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download room" }).click();
  const backup = await (await download).path();

  // A new context starts without the first browser's localStorage or IndexedDB.
  const fresh = await browser.newContext();
  const restored = await fresh.newPage();
  await restored.goto("/");
  await expect(
    restored.getByRole("button", { name: /^Open the sample room/ }),
  ).toBeVisible();
  await restored
    .getByLabel("Import room JSON or scan ZIP")
    .setInputFiles(backup);
  await expect(
    restored.getByRole("button", { name: "Products · $79", exact: true }),
  ).toBeVisible();
  await restored.reload();
  await expect(
    restored.getByRole("button", { name: "Products · $79", exact: true }),
  ).toBeVisible();
  await fresh.close();
});

for (const failure of [
  "WebGL is unavailable",
  "WebGL initialization throws",
  "WebGL2 is unavailable",
] as const) {
  test(`floor plan selection works when ${failure}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((failure) => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        ...args: Parameters<typeof original>
      ) {
        if (
          failure === "WebGL2 is unavailable"
            ? args[0] === "webgl2"
            : String(args[0]).includes("webgl")
        ) {
          if (failure === "WebGL initialization throws")
            throw new Error("WebGL is disabled");
          return null;
        }
        return original.apply(this, args);
      } as typeof original;
    }, failure);
    await page.goto("/");
    await page.getByRole("button", { name: /^Open the sample room/ }).click();
    await expect(
      page.getByRole("img", { name: "Room floor plan" }),
    ).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Select Sofa 1", exact: true })
      .press("Enter");
    await expect(
      page.getByRole("button", { name: "Select Sofa 1", exact: true }),
    ).toHaveClass(/stroke-teal/);
    expect(errors).toEqual([]);
  });
}
