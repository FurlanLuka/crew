class Crew < Formula
  desc "Agent team launcher with workspace & project management"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "be3e1eecfd8a6be1abba7130056058bc4d3405e7580f6c9d2654da3ad6a55e45"
  license "MIT"

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
    assert_match "Agent team launcher", shell_output("#{bin}/crew help")
  end
end
