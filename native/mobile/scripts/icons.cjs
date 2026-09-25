/* Reuses the repository's geometric AppLogo; no new branding or remote asset. */
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('../../../node_modules/sharp')
const root = path.resolve(__dirname, '..')
async function main() {
  const icon = await fs.readFile(path.join(root, 'assets/icon.svg'))
  await sharp(icon).png().toFile(path.join(root, 'assets/icon.png'))
  await sharp(icon).removeAlpha().png().toFile(path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'))
  const res = path.join(root, 'android/app/src/main/res')
  for (const [density,size] of Object.entries({mdpi:48,hdpi:72,xhdpi:96,xxhdpi:144,xxxhdpi:192})) {
    for(const name of ['ic_launcher.png','ic_launcher_round.png']) await sharp(icon).resize(size,size).png().toFile(path.join(res, 'mipmap-'+density, name))
    const fg = icon.toString().replace(/ {2}<rect[^>]+\/>\n/, '')
    await sharp(Buffer.from(fg)).resize(Math.round(size*2.25)).png().toFile(path.join(res, 'mipmap-'+density,'ic_launcher_foreground.png'))
  }
  // Remove generated template splash bitmaps; use a single solid native launch background.
  for (const entry of await fs.readdir(res)) {
    if (entry.startsWith('drawable')) await fs.rm(path.join(res, entry, 'splash.png'), {force:true})
  }
  await fs.writeFile(path.join(res, 'drawable/splash.xml'), '<shape xmlns:android="http://schemas.android.com/apk/res/android"><solid android:color="#0b0e0b"/></shape>\n')
  await fs.writeFile(path.join(res,'drawable/ic_launcher_background.xml'),'<shape xmlns:android="http://schemas.android.com/apk/res/android"><solid android:color="#0b0e0b"/></shape>\n')
  await fs.rm(path.join(res,'drawable-v24/ic_launcher_foreground.xml'),{force:true})
  // A neutral launch image avoids displaying a different framework logo during startup.
  const splash = path.join(root,'ios/App/App/Assets.xcassets/Splash.imageset')
  for(const name of await fs.readdir(splash)) if(name.endsWith('.png')) await sharp({create:{width:2732,height:2732,channels:3,background:'#0b0e0b'}}).png().toFile(path.join(splash,name))
}
main().catch(error=>{ process.stderr.write(error.message+'\n');process.exitCode=1 })
