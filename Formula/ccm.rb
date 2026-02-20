class Ccm < Formula
  desc "Claude Code Manager — package manager for agents and skills"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.15.0.tar.gz"
  sha256 "dfd68e486ebc9fdfd80a41070bd6805ede738e01da61c0e53f2ec930c8f41c41"
  license "MIT"

  depends_on "gum"

  def install
    bin.install "ccm/ccm"
  end

  test do
    assert_match "Claude Code Manager", shell_output("#{bin}/ccm help")
  end
end
