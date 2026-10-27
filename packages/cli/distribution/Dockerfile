# Build the Linux glibc target first. The image contains no build toolchain.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
ARG TCACHE_ARCH=arm64
COPY --chmod=755 dist/tcache-linux-${TCACHE_ARCH} /usr/local/bin/tcache
COPY dist/THIRD_PARTY_LICENSES.txt dist/LICENSE.bun /usr/share/licenses/tcache/
USER nonroot:nonroot
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/tcache"]
CMD ["--help"]
