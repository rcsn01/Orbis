# Distributing Orbis without a paid Apple Developer account

## Conclusion

There is no free route to the normal macOS distribution experience for an app downloaded from the internet. Apple’s Developer ID certificate is the trust mechanism Gatekeeper uses for software distributed outside the Mac App Store, and Apple says the certificate requires membership in the Apple Developer Program. The program costs USD 99 per membership year, with fee waivers available to some nonprofits, accredited educational institutions, and government entities.

A free Apple Account can be used with Xcode as a Personal Team for testing on personal devices. Apple limits that route to three devices and three installed apps, with App IDs, devices, and provisioning profiles expiring after seven days. Apple does not describe Personal Team signing as a way to distribute a Mac app to arbitrary users.

The practical free option is to distribute an unsigned or ad-hoc-signed build and give each trusted user manual Gatekeeper instructions. That works as a developer/testing workflow, but it does not establish publisher identity, does not provide Apple malware notarization, and may be blocked by managed Mac policies.

## Options and limits

| Option | Cost | Result | Limitations |
| --- | --- | --- | --- |
| Developer ID Application signing and Apple notarization | Apple Developer Program membership, normally USD 99/year | Normal direct distribution outside the Mac App Store | Requires Apple account enrollment, signing credentials, hardened-runtime-compatible packaging, notarization, and release credentials |
| Free Apple Account / Xcode Personal Team | Free | Test apps on a small number of personal devices | Seven-day provisioning; not a general distribution channel; no Developer ID certificate |
| Unsigned or ad-hoc-signed DMG | Free | Trusted users can launch it after manually approving or removing quarantine | Gatekeeper warnings or blocks, no verified publisher identity, no notarization, and a poor install experience |
| Self-signed or locally trusted certificate | No Apple membership, but setup is required on each Mac | Can be useful in a controlled environment where users install and trust the certificate | Not Apple-trusted; not notarized; unsuitable for arbitrary public downloads |

Apple documents that a user may override Gatekeeper for software they trust, but also warns that unsigned and unnotarized software has not received Apple’s malware checks. Electron’s documentation makes the same distinction: unsigned apps can be distributed, but users must complete multiple advanced manual steps.

## Implications for Orbis

Orbis currently uses an unsigned ARM64 macOS package:

- `electron-builder.yml` sets `mac.identity: null` and `hardenedRuntime: false`.
- `package:mac:unsigned` and the release script intentionally produce an unsigned DMG.
- The current package is therefore suitable for trusted local testing, not frictionless public distribution.
- The README documents quarantine removal and local ad-hoc re-signing as workarounds. Those commands must be used only for a build the user trusts. They do not turn the package into a Developer ID-signed or notarized release.

To distribute Orbis normally, the release process needs a Developer ID Application certificate, signing of the app and embedded native code, hardened runtime settings and required entitlements, notarization, and stapling of the notarization ticket. If the goal is only a small group of trusted testers, keeping the unsigned build and providing the documented manual launch steps avoids the annual membership fee.

## Sources

- Apple, [Developer ID](https://developer.apple.com/developer-id/): Developer ID certificates let Gatekeeper verify software distributed outside the Mac App Store; notarization submits signed software to Apple for malware checks.
- Apple, [Developer account overview](https://developer.apple.com/support/compare-memberships/): free Personal Team testing limits and the distinction between a free account and a Developer Program membership.
- Apple, [Become a member](https://developer.apple.com/programs/enroll/): Apple Developer Program pricing and fee-waiver eligibility.
- Apple, [Developer ID certificates](https://developer.apple.com/help/account/create-certificates/create-developer-id-certificates/): Developer ID certificate creation and the requirement for a developer account/team; signed software can be submitted for notarization.
- Apple Support, [Safely open apps on your Mac](https://support.apple.com/en-us/102445): Gatekeeper checks, notarization warnings, and the user-facing Open Anyway override.
- Apple Platform Security, [Gatekeeper and runtime protection](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web): Gatekeeper verification and the fact that users or organizations can override policy, subject to management restrictions.
- Electron, [Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing): unsigned Electron apps can be distributed only with advanced manual user steps; normal macOS release preparation uses signing followed by notarization.
- electron-builder, [Code Signing](https://www.electron.build/docs/features/code-signing/): direct macOS distribution uses a Developer ID Application certificate and notarization; missing credentials can leave production output unsigned.
