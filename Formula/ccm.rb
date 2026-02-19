class Ccm < Formula
  desc "Claude Code Manager — package manager for agents and skills"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.8.0.tar.gz"
  sha256 "e39a71f61d8116616c9ea299300cfde6acc0825210c8ecb5b720b9625c871450"
  license "MIT"

  def install
    bin.install "ccm/ccm"
  end

  test do
    assert_match "Claude Code Manager", shell_output("#{bin}/ccm help")
  end
end
