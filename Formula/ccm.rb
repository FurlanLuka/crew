class Ccm < Formula
  desc "Claude Code Manager — package manager for agents and skills"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.14.0.tar.gz"
  sha256 "c693d0ad35e588cb3f02e2c1053a92ef75502662675de8d8343cada21aa1e3e0"
  license "MIT"

  depends_on "gum"

  def install
    bin.install "ccm/ccm"
  end

  test do
    assert_match "Claude Code Manager", shell_output("#{bin}/ccm help")
  end
end
