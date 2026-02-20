class Crew < Formula
  desc "Agent team launcher with workspace & project management"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.19.0.tar.gz"
  sha256 "41d83b35bd0324c243e57a66236a641293c15c3a05e9d96ac5521d1168186fd1"
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
