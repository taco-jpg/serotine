#!/usr/bin/env bash
# Run only on an ephemeral macOS runner with protected release credentials.
set -euo pipefail
set +x

: "${RUNNER_TEMP:?Use an ephemeral release runner}"
: "${IOS_DISTRIBUTION_CERT_BASE64:?Missing iOS distribution certificate}"
: "${IOS_CERT_PASSWORD:?Missing iOS distribution certificate password}"
: "${IOS_PROVISION_PROFILE_BASE64:?Missing App Store provisioning profile}"
: "${APPLE_TEAM_ID:?Missing Apple team ID}"
: "${EXPECTED_VERSION:?Missing release version}"
: "${SEROTINE_BUILD_NUMBER:?Missing build number}"

SEROTINE_SIGNING_DIR="$(mktemp -d "$RUNNER_TEMP/serotine-signing.XXXXXX")"
export SEROTINE_SIGNING_DIR
SEROTINE_KEYCHAIN="$SEROTINE_SIGNING_DIR/signing.keychain-db"
SEROTINE_KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
SEROTINE_INSTALLED_PROFILE=''
cleanup() {
  security delete-keychain "$SEROTINE_KEYCHAIN" >/dev/null 2>&1 || true
  if [ -n "$SEROTINE_INSTALLED_PROFILE" ]; then rm -f "$SEROTINE_INSTALLED_PROFILE"; fi
  rm -rf "$SEROTINE_SIGNING_DIR"
}
trap cleanup EXIT

python3 - <<'PY'
import base64, os, pathlib
directory = pathlib.Path(os.environ['SEROTINE_SIGNING_DIR'])
for variable, name in [('IOS_DISTRIBUTION_CERT_BASE64', 'certificate.p12'), ('IOS_PROVISION_PROFILE_BASE64', 'profile.mobileprovision')]:
    data = base64.b64decode(os.environ[variable], validate=True)
    (directory / name).write_bytes(data)
    (directory / name).chmod(0o600)
PY
security cms -D -i "$SEROTINE_SIGNING_DIR/profile.mobileprovision" > "$SEROTINE_SIGNING_DIR/profile.plist"
python3 - <<'PY'
import datetime, os, pathlib, plistlib, re
directory = pathlib.Path(os.environ['SEROTINE_SIGNING_DIR'])
profile = plistlib.loads((directory / 'profile.plist').read_bytes())
team = os.environ['APPLE_TEAM_ID']
entitlements = profile['Entitlements']
if not re.fullmatch(r'[A-Z0-9]{10}', team):
    raise SystemExit('Invalid team ID')
if entitlements.get('application-identifier') != team + '.app.serotine.client':
    raise SystemExit('Profile must be for app.serotine.client and the configured team')
if entitlements.get('get-task-allow') or profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices'):
    raise SystemExit('An App Store distribution profile is required')
if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    raise SystemExit('Provisioning profile has expired')
uuid = profile['UUID']
if not re.fullmatch(r'[0-9A-Fa-f-]{36}', uuid):
    raise SystemExit('Invalid provisioning profile UUID')
(directory / 'profile-uuid').write_text(uuid)
options = {'method': 'app-store-connect', 'destination': 'export', 'signingStyle': 'manual',
           'teamID': team, 'signingCertificate': 'Apple Distribution',
           'provisioningProfiles': {'app.serotine.client': uuid},
           'manageAppVersionAndBuildNumber': False, 'uploadSymbols': False}
(directory / 'ExportOptions.plist').write_bytes(plistlib.dumps(options))
PY
SEROTINE_PROFILE_UUID="$(cat "$SEROTINE_SIGNING_DIR/profile-uuid")"
mkdir -p "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
SEROTINE_INSTALLED_PROFILE="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/$SEROTINE_PROFILE_UUID.mobileprovision"
cp "$SEROTINE_SIGNING_DIR/profile.mobileprovision" "$SEROTINE_INSTALLED_PROFILE"
security create-keychain -p "$SEROTINE_KEYCHAIN_PASSWORD" "$SEROTINE_KEYCHAIN"
security set-keychain-settings -lut 21600 "$SEROTINE_KEYCHAIN"
security unlock-keychain -p "$SEROTINE_KEYCHAIN_PASSWORD" "$SEROTINE_KEYCHAIN"
security import "$SEROTINE_SIGNING_DIR/certificate.p12" -P "$IOS_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -t cert -f pkcs12 -k "$SEROTINE_KEYCHAIN" >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$SEROTINE_KEYCHAIN_PASSWORD" "$SEROTINE_KEYCHAIN" >/dev/null
security list-keychains -d user -s "$SEROTINE_KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"

xcodebuild -project native/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$RUNNER_TEMP/Serotine.xcarchive" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" PROVISIONING_PROFILE_SPECIFIER="$SEROTINE_PROFILE_UUID" \
  PRODUCT_BUNDLE_IDENTIFIER=app.serotine.client \
  MARKETING_VERSION="$EXPECTED_VERSION" CURRENT_PROJECT_VERSION="$SEROTINE_BUILD_NUMBER" archive
xcodebuild -exportArchive -archivePath "$RUNNER_TEMP/Serotine.xcarchive" \
  -exportOptionsPlist "$SEROTINE_SIGNING_DIR/ExportOptions.plist" \
  -exportPath native/mobile/ios/release

# The archive's app signature is verified locally; upload to TestFlight remains manual.
codesign --verify --deep --strict "$RUNNER_TEMP/Serotine.xcarchive/Products/Applications/App.app"
