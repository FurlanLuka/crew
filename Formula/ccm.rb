class Ccm < Formula
  desc "Claude Code Manager — package manager for agents and skills"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.18.0.tar.gz"
  sha256 "64d5d1279b8c509cd34f45f8f5aeae052d751474f2dd4e641f60faf0c4db1a00"
  license "MIT"

  depends_on "gum"

  def install
    bin.install "ccm/ccm"
  end

  test do
    assert_match "Claude Code Manager", shell_output("#{bin}/ccm help")
  end
end
