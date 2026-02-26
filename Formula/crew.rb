class Crew < Formula
  desc "Agent team launcher, workspace manager & package registry"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.26.5.tar.gz"
  sha256 "4427f331cf8c642e44a5d82812bc47015cee685f65ae8ac3ddce2abd94d89acb"
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
