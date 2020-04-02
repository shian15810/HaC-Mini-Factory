'use strict';

const crypto = require('crypto');
const { promises: fs } = require('fs');
const { EOL } = require('os');
const { URL } = require('url');

const core = require('@actions/core');
const globby = require('globby');
const micromatch = require('micromatch');
const mkdirp = require('mkdirp');
const fetch = require('node-fetch');
const wretch = require('wretch');

const {
  ARTIFACT_PATH,
  CHANGELOG_NAME,
  DRIVER_SOURCE_PATH,
  GITHUB_TOKEN,
  REPOSITORY_FULL_NAME,
  REPOSITORY_NAME,
} = process.env;

const index = async () => {
  const glob = `${REPOSITORY_NAME}/${DRIVER_SOURCE_PATH}`;
  const paths = await globby(glob);
  core.info(`Repository: ${REPOSITORY_FULL_NAME}`);

  const drivers = await Promise.all(
    paths.map(async (path) => {
      const [name] = micromatch.capture(glob, path);
      const source = await fs.readFile(path, { encoding: 'utf8' });
      const [url, sha256] = source.split(EOL);
      const { hostname, pathname } = new URL(url);
      const pathnames = pathname.split('/');
      if (hostname === 'bitbucket.org') {
        const [, owner, repo, , asset] = pathnames;
        return { asset, hostname, name, owner, path, repo, sha256, url };
      } else if (hostname === 'github.com') {
        const [, owner, repo, , , tag, asset] = pathnames;
        return { asset, hostname, name, owner, path, repo, sha256, tag, url };
      }
      return { hostname, name, path, sha256, url };
    }),
  );
  if (drivers.length > 0) {
    const info = drivers
      .map(({ asset, name, tag }) => `Driver: ${name} ${tag || asset || ''}`)
      .join(EOL);
    core.info(info);
  }

  wretch().polyfills({ fetch });
  const github = wretch('https://api.github.com').auth(
    `Bearer ${GITHUB_TOKEN}`,
  );
  const updates = await Promise.all(
    drivers
      .filter(({ hostname }) => hostname === 'github.com')
      .map(async (driver) => {
        const { asset, owner, repo, tag } = driver;
        const { assets, tag_name: latest } = await github
          .url(`/repos/${owner}/${repo}/releases/latest`)
          .get()
          .json();
        if (tag === latest) {
          return undefined;
        }
        const { browser_download_url: url, id } =
          assets.find(({ name }) => asset.split(tag).join(latest) === name) ||
          {};
        if (id === undefined) {
          return undefined;
        }
        const download = await github
          .url(`/repos/${owner}/${repo}/releases/assets/${id}`)
          .options({ redirect: 'manual' })
          .accept('application/octet-stream')
          .get()
          .error(302, ({ response: { headers } }) =>
            wretch(headers.get('Location')).get().arrayBuffer(),
          )
          .arrayBuffer();
        const hash = crypto.createHash('sha256');
        hash.update(Buffer.from(download));
        const sha256 = hash.digest('hex');
        return { ...driver, latest, sha256, tag, url };
      }),
  ).then((updates) => updates.filter((update) => update !== undefined));
  if (updates.length > 0) {
    const info = updates
      .map(({ latest, name, tag }) => `Update: ${name} ${tag} => ${latest}`)
      .join(EOL);
    core.info(info);
  }

  await Promise.all(
    updates.map(({ path, sha256, url }) =>
      fs.writeFile(path, [url, sha256].join(EOL)),
    ),
  );
  const changelog = [
    '## Build Repository',
    `[${REPOSITORY_FULL_NAME}](https://github.com/${REPOSITORY_FULL_NAME})`,
    ...(updates.length === 0 ? [] : ['## Driver Updates']),
    ...updates.map(({ latest, name, tag }) => `- ${name} ${tag} => ${latest}`),
  ].join(EOL);
  await mkdirp(`${REPOSITORY_NAME}/${ARTIFACT_PATH}`);
  await fs.writeFile(
    `${REPOSITORY_NAME}/${ARTIFACT_PATH}/${CHANGELOG_NAME}`,
    changelog.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'),
  );
  core.info(`${CHANGELOG_NAME}:`);
  core.info(changelog);
};

index().catch((error) => core.setFailed(error.message));
