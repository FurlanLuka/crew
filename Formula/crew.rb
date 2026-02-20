class Crew < Formula
  desc "Agent team launcher, workspace manager & package registry"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.24.0.tar.gz"
  sha256 "d2a95aa205798ac62aad10fa939aa6acc79013ff60f225dccc53f5b6035fd862"
  license "MIT"

  depends_on "gum"
  depends_on "tmux"

  def install
    bin.install "crew/crew"
  end

  def caveats
    <<~EOS
      crew requires python3 on your PATH.
      If you don't have it: brew install python@3
    EOS
  end

  test do
    assert_match "Agent team launcher & registry", shell_output("#{bin}/crew help")
  end
end
