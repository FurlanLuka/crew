class Crew < Formula
  desc "Agent team launcher, workspace manager & package registry"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.25.2.tar.gz"
  sha256 "accf982884971e37117f60e3ab57d6145e9624b3fe1e5373b15373809daf62c5"
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
