import { expect } from '@playwright/test'

export async function dismissIdentity(page) {
  const picker = page.getByRole('dialog', { name: '选择本人', exact: true })
  await picker.getByRole('button', { name: '取消', exact: true }).click()
  await expect(picker).toHaveCount(0)
}
