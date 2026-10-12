import { expect, test, type Page } from '@playwright/test';

const DOC = 'New workspaces start with 30 free credits. One credit renders one minute of video.';

async function open(page: Page, workspace: string) {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Connected');
  const ws = page.getByLabel('Workspace');
  await ws.fill(workspace);
  await ws.press('Enter');
}

async function storeDoc(page: Page, result = 'onboarding.md: 1 chunk stored') {
  await page.getByText('Or paste text').click();
  await page.getByLabel('Name').fill('onboarding.md');
  await page.getByLabel('Document text').fill(DOC);
  await page.getByRole('button', { name: 'Store text' }).click();
  await expect(page.getByRole('list', { name: 'Stored documents' })).toContainText(result);
}

async function ask(page: Page, question: string) {
  await page.getByLabel('Question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
  return page.getByRole('article', { name: question });
}

test('stores a document and streams a cited answer', async ({ page }) => {
  await open(page, `e2e-${Date.now()}`);
  await storeDoc(page);
  const turn = await ask(page, 'how many free credits does a new workspace get');

  // While tokens arrive the answer is partial and the Ask button turns into Stop.
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(turn).toHaveAttribute('data-state', 'grounded');
  await expect(turn.getByTestId('answer')).toHaveText('New workspaces start with 30 free credits [1].');
  await expect(turn.getByLabel('Sources')).toContainText('[1] onboarding.md');
  await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible();
});

test('refuses when the workspace has nothing relevant', async ({ page }) => {
  await open(page, `empty-${Date.now()}`);
  const turn = await ask(page, 'who founded the company in paris');
  await expect(turn).toHaveAttribute('data-state', 'refused');
  await expect(turn.getByTestId('answer')).toHaveText("I can't find that in this workspace's documents.");
  await expect(turn.getByLabel('Sources')).toHaveCount(0);
});

test('Stop cancels an answer mid-stream', async ({ page }) => {
  await open(page, `stop-${Date.now()}`);
  await storeDoc(page);
  const turn = await ask(page, 'how many free credits does a new workspace get');
  await expect(turn.getByTestId('answer')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(turn).toHaveAttribute('data-state', 'stopped');
  await expect(turn.getByTestId('answer')).toContainText('(stopped)');
  await expect(turn.getByTestId('answer')).not.toContainText('[1].');
});

test('shows validation errors from the server', async ({ page }) => {
  await open(page, 'not a valid workspace');
  await storeDoc(page, 'onboarding.md: workspace: letters, digits, dot, dash or underscore');
});

test('reports an unreachable server and recovers', async ({ page }) => {
  await page.goto('/');
  const server = page.getByLabel('Server');
  await server.fill('http://127.0.0.1:9');
  await server.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Server unreachable');
  await expect(page.getByRole('button', { name: 'Ask' })).toBeDisabled();
  await server.fill('http://127.0.0.1:3171');
  await server.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Connected');
});
