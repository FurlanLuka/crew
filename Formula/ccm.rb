class Ccm < Formula
  desc "Claude Code Manager — package manager for agents and skills"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.22.0.tar.gz"
  sha256 "6a6d866eb7f71170dfc2c4769dd91bb4284a916501a1ac8d2a82121ce39ce4aa"
  license "MIT"

  depends_on "gum"

  def install
    bin.install "ccm/ccm"
  end

  test do
    assert_match "Claude Code Manager", shell_output("#{bin}/ccm help")
  end
end
