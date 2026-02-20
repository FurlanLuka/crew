class Crew < Formula
  desc "Agent team launcher, workspace manager & package registry"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.24.1.tar.gz"
  sha256 "610fa03c74a0420891831e93e351b8a74483abc0cea7b76a87083cb50f7516bf"
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
