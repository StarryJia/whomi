export function chatEditor(page) {
  return page.getByRole('textbox', { name: '向 AI 提问', exact: true })
    .and(page.locator('.composer-tiptap'))
}
