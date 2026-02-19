class Ccm < Formula
  desc "Claude Code Manager — package manager for agents and skills"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.12.0.tar.gz"
  sha256 "7ff24fd7c62bfc8449a6a6ce107b91b614e00ae7ebd03fb44b6810e220dc13e1"
  license "MIT"

  depends_on "gum"

  def install
    bin.install "ccm/ccm"
  end

  test do
    assert_match "Claude Code Manager", shell_output("#{bin}/ccm help")
  end
end
