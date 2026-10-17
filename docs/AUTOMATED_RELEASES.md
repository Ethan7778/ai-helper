# Automatic Chrome Web Store updates

Pushing to `main` runs `.github/workflows/publish-extension.yml`. The workflow installs dependencies, checks types, runs tests, builds the extension, and packages the contents of `extension/dist`. Source maps are excluded from the store ZIP.

It authenticates through Google Workload Identity Federation and submits the package to the existing [ai chat threads store listing](https://chromewebstore.google.com/detail/anafheflkkjibeckbafcmikiecgnpmdj). No GitHub secrets or JSON keys are required with this configuration.

## Release an update

1. Finish your changes.
2. Run `npm run release:bump` to increase the patch version in the manifest, package.json, and package-lock.json together. The version must be higher than all previous store uploads; if you uploaded a higher version manually, first align these files with that version.
3. Commit your changes, including the three version files, and push to `main`.
4. Open the repository's **Actions** tab and select **Publish Chrome extension** to see the result.

Chrome still reviews updates. A successful submission will publish automatically after approval; installed extensions receive it through Chrome's normal update process. An Actions success means the update was submitted or skipped, not necessarily that it is live. Read the submission step summary for the result.

If the version is already published, older than a published version, or already awaiting review, the workflow skips submission. A code change without a version bump therefore does not release a new build.

If another version is pending review, or a submission is staged, the workflow stops. Resolve that submission in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), then use **Actions > Publish Chrome extension > Run workflow** on `main` to retry. Failed/rejected uploads may require another version bump. The workflow does not cancel reviews automatically.

## Configured connection

- Repository: `Ethan7778/ai-helper`, branch `main`
- Google Cloud project: `adept-shade-487122-e9`
- Identity provider: `projects/189485354749/locations/global/workloadIdentityPools/github/providers/ai-helper`
- Service account: `github-chrome-publisher@adept-shade-487122-e9.iam.gserviceaccount.com`
- Publisher ID: `38cbcfb3-234f-4337-a439-cbedbae55013`
- Extension ID: `anafheflkkjibeckbafcmikiecgnpmdj`

The provider restricts authentication to this repository's `main` branch. Renaming the repository or release branch requires updating both the Google provider condition/IAM binding and the workflow.

For authentication errors, confirm the service account is still linked to your Chrome Web Store publisher and allow newly changed IAM permissions five minutes to propagate. Store listing, privacy, and visibility changes may still require dashboard updates.

References: [Google authentication setup](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account), [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api).
