# Vendored dependency: merchantid

`merchantid-0.1.1-db51ed9.tgz` is a `npm pack` artifact of the hardened fork:

- Repository: <https://github.com/FarelRA/merchantid>
- Branch: `kalanidhi-hardening`
- Commit: `db51ed9a9ae1db0a0fe1f0bf1665dcfd41e760b6`
- Upstream: <https://github.com/alhifnywahid/merchantid> (MIT)
- License: MIT (see the `LICENSE` file inside the tarball)
- SHA-256: `238e89b1243583954a6b7028ee7f3361597e28e21ddd66c504bf7d3b78d4a09d`

The fork does not commit `dist/`, and its `package.json` has only a `prepack`
script (no `prepare`). A plain git dependency would therefore install without
build output. The tarball is produced with `npm pack` at the pinned commit,
which runs `prepack` and bundles the ESM/CJS builds and declarations.

Regenerate from a trusted checkout:

```sh
git clone https://github.com/FarelRA/merchantid.git
cd merchantid
git checkout db51ed9a9ae1db0a0fe1f0bf1665dcfd41e760b6
npm ci
npm pack --pack-destination /path/to/kalanidhi-payments/vendor
# rename to merchantid-0.1.1-db51ed9.tgz and update the SHA-256 above
```

`package.json` references it as `file:vendor/merchantid-0.1.1-db51ed9.tgz`, so
`npm ci` and the Docker build need neither git nor network access to GitHub.
