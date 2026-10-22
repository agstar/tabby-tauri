import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const componentPath = resolve(repoRoot, 'tabby', 'tabby-settings', 'src', 'components', 'profilesSettingsTab.component.pug')
const stylePath = resolve(repoRoot, 'tabby', 'tabby-settings', 'src', 'components', 'profilesSettingsTab.component.scss')

const componentSource = readFileSync(componentPath, 'utf8')
const styleSource = readFileSync(stylePath, 'utf8')

test('profile row actions use a large non-bubbling dropdown hit target', () => {
    assert.match(
        componentSource,
        /\.profile-actions\.ms-1\.hover-reveal\(ngbDropdown,[\s\S]*\(click\)='\$event\.stopPropagation\(\)'/,
    )

    assert.match(
        componentSource,
        /button\.btn\.btn-link\.profile-actions-toggle\.ms-1\([\s\S]*ngbDropdownToggle,[\s\S]*type='button'[\s\S]*aria-label='Profile actions'[\s\S]*\(click\)='\$event\.stopPropagation\(\)'/,
    )

    assert.match(styleSource, /\.profile-actions\s*\{[\s\S]*flex-shrink:\s*0/)
    assert.match(styleSource, /\.profile-actions-toggle\s*\{[\s\S]*min-width:\s*2\.25rem/)
    assert.match(styleSource, /\.profile-actions-toggle\s*\{[\s\S]*min-height:\s*2\.25rem/)
    assert.match(styleSource, /\.profile-actions-toggle\s*\{[\s\S]*display:\s*inline-flex/)
    assert.match(styleSource, /\.profile-actions-toggle\s*\{[\s\S]*align-items:\s*center/)
    assert.match(styleSource, /\.profile-actions-toggle\s*\{[\s\S]*justify-content:\s*center/)
})
