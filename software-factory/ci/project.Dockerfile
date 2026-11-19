# The project layer on top of the heavy runners' image (ci.projectImage, off by default): the packages in main's
# lockfile, already downloaded, so a job's `pnpm install` finds them on local disk instead of the network.
# project-image.sh builds it on this machine as <name>-runner:project. The build context holds only main's
# pnpm-lock.yaml (and pnpm-workspace.yaml and .npmrc when main has them), fetched from GitHub by their git hashes:
# never a pull request's files, and no package.json, so there is no script to run.
#   BASE_IMAGE  the image `factory ci install` built (<name>-runner:latest), which has the project's pnpm
# Docker's layer cache keys the fetch on those files: the same lockfile is a no-op, a new one fetches again.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS fetch
USER root
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /tmp/factory-project
COPY . ./
# Downloads every package in the lockfile into a store and runs no package script.
# go-w: nobody but root can change a stored file, whatever umask the build had.
RUN pnpm fetch --ignore-scripts --store-dir /tmp/factory-store \
 && chmod -R a+rX,go-w /tmp/factory-store

FROM ${BASE_IMAGE}
USER root
# Root's, and read-only to the jobs' user (runner): a job copies from it into its own throwaway store. The image
# can't be written from a container at all, so nothing a job does reaches the next job.
COPY --from=fetch --chown=root:root /tmp/factory-store/ /opt/factory-ci/cache/pnpm-store/
USER runner
