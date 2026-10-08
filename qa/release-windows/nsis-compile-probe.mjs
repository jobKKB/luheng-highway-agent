/** Compile the official installer and uninstaller without executing either product flow. */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [rootArgument, builderArgument] = process.argv.slice(2)
if (!rootArgument || !builderArgument) throw new Error('Expected scratch and pinned builder paths')
const root = path.resolve(rootArgument)
const builder = path.resolve(builderArgument)
const base = path.join(builder, 'dist/targets/win/nsis')
const { NsisScriptGenerator } = await import(pathToFileURL(path.join(base, 'nsisScriptGenerator.js')))
const { LangConfigurator, createAddLangsMacro, addCustomMessageFileInclude } = await import(pathToFileURL(path.join(base, 'nsisLang.js')))
const generator = new NsisScriptGenerator()
generator.include(path.join(builder, 'templates/nsis/include/StdUtils.nsh'))
generator.addIncludeDir(path.join(builder, 'templates/nsis/include'))
generator.flags(['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser'])
const languages = new LangConfigurator({ installerLanguages: ['en_US'] })
createAddLangsMacro(generator, languages)
let index = 0
for (const name of ['messages.yml', 'assistedMessages.yml']) {
  await addCustomMessageFileInclude(name, {
    getTempFile: async () => path.join(root, `messages-${index++}.nsh`)
  }, generator, languages)
}
generator.include(path.join(root, 'templates/header.nsh'))
const defines = {
  APP_ID: 'fixture.longpath', APP_GUID: '12345678-abcd-1234-abcd-123456789abc',
  UNINSTALL_APP_KEY: 'fixture-longpath', PRODUCT_NAME: 'Synthetic long path fixture',
  PRODUCT_FILENAME: 'Fixture', APP_FILENAME: 'Fixture', APP_DESCRIPTION: 'Synthetic fixture',
  VERSION: '0.0.1', PROJECT_DIR: root, BUILD_RESOURCES_DIR: root, APP_PACKAGE_NAME: 'fixture',
  APP_INSTALLER_STORE_FILE: 'fixture-cache\\installer.exe', COMPRESSION_METHOD: '7z',
  INSTALL_MODE_PER_ALL_USERS_REQUIRED: null, SHORTCUT_NAME: 'Fixture',
  UNINSTALL_DISPLAY_NAME: 'Fixture', DO_NOT_CREATE_DESKTOP_SHORTCUT: null,
  APP_64: path.join(root, 'A.7z'), APP_64_UNPACKED_SIZE: 1,
  UNINSTALLER_OUT_FILE: path.join(root, 'synthetic-uninstaller.exe')
}
const definitions = Object.entries(defines).map(([key, value]) => `!define ${key}${value === null ? '' : ` "${value}"`}`).join('\n')
// This file only satisfies NSIS File at compile time; no generated full installer runs.
fs.writeFileSync(path.join(root, 'synthetic-uninstaller.exe'), 'MZsynthetic compile-time placeholder', { flag: 'wx' })
for (const pass of ['installer', 'uninstaller']) {
  const script = `Unicode true\nOutFile "${path.join(root, `official-${pass}.exe`)}"\n` +
    `${definitions}\n${pass === 'uninstaller' ? '!define BUILD_UNINSTALLER\n' : ''}` +
    generator.build() + fs.readFileSync(path.join(builder, 'templates/nsis/installer.nsi'), 'utf8')
  fs.writeFileSync(path.join(root, `official-${pass}.nsi`), script, { flag: 'wx' })
}
